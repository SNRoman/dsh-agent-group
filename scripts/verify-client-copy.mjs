import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const DISPLAY_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder'])
const DISPLAY_HELPER_NAME = /(?:display|label|title|message|description|placeholder|empty|status|error)/i

const requestedRoot = readRootArgument(process.argv.slice(2))
const root = resolve(requestedRoot ?? fileURLToPath(new URL('../packages/web/src/client', import.meta.url)))
const diagnostics = []

for (const file of sourceFiles(root)) inspectFile(file)

for (const diagnostic of diagnostics) {
  process.stderr.write(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} [${diagnostic.category}] ${diagnostic.message}\n`)
}
if (diagnostics.length > 0) process.exitCode = 1

function readRootArgument(args) {
  if (args.length === 0) return undefined
  if (args.length === 2 && args[0] === '--root') return args[1]
  throw new Error('usage: node scripts/verify-client-copy.mjs [--root <file-or-directory>]')
}

function sourceFiles(entry) {
  const stat = statSync(entry)
  if (stat.isFile()) return isSourceFile(entry) ? [entry] : []
  return readdirSync(entry, { withFileTypes: true })
    .flatMap(child => sourceFiles(resolve(entry, child.name)))
    .sort()
}

function isSourceFile(file) {
  return ['.ts', '.tsx'].includes(extname(file)) && basename(file) !== 'locales.ts'
}

function inspectFile(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  visit(source)

  function visit(node) {
    if (ts.isJsxText(node) && node.text.trim() !== '' && !isHiddenGlyph(node) && !isTechnicalJsxText(node)) {
      report(source, node, 'jsx-text', 'move display text to agentWorkspace locale')
    }
    if (ts.isJsxExpression(node)
      && !ts.isJsxAttribute(node.parent)
      && containsDisplayLiteral(node.expression)
      && !isTechnicalJsxExpression(node)) {
      report(source, node, 'jsx-text', 'move display expression text to agentWorkspace locale')
    }
    if (ts.isJsxAttribute(node)) inspectAttribute(source, node)
    if (ts.isReturnStatement(node) && containsDisplayLiteral(node.expression) && isDisplayHelper(node)) {
      report(source, node.expression, 'display-helper-return', 'return translated display text instead of a literal')
    }
    ts.forEachChild(node, visit)
  }
}

function inspectAttribute(source, attribute) {
  const name = attribute.name.text
  if (!DISPLAY_ATTRIBUTES.has(name)) return
  if (attribute.initializer !== undefined && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text.trim() !== '') {
    report(source, attribute.initializer, name, `translate literal ${name}`)
    return
  }
  if (attribute.initializer !== undefined
    && ts.isJsxExpression(attribute.initializer)
    && containsDisplayLiteral(attribute.initializer.expression)) {
    report(source, attribute.initializer, name, `translate literal ${name} expression`)
  }
}

function containsDisplayLiteral(node) {
  if (node === undefined) return false
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.trim() !== ''
  if (ts.isTemplateExpression(node)) {
    return node.head.text.trim() !== '' || node.templateSpans.some(span => span.literal.text.trim() !== '')
  }
  if (ts.isParenthesizedExpression(node)) return containsDisplayLiteral(node.expression)
  if (ts.isConditionalExpression(node)) {
    return containsDisplayLiteral(node.whenTrue) || containsDisplayLiteral(node.whenFalse)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return containsDisplayLiteral(node.left) || containsDisplayLiteral(node.right)
  }
  return false
}

function isDisplayHelper(returnStatement) {
  let current = returnStatement.parent
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const name = functionName(current)
      return name !== undefined && DISPLAY_HELPER_NAME.test(name)
    }
    current = current.parent
  }
  return false
}

function functionName(node) {
  if ('name' in node && node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return undefined
}

function isHiddenGlyph(text) {
  const parent = text.parent
  if (!ts.isJsxElement(parent)) return false
  const attribute = parent.openingElement.attributes.properties.find(property =>
    ts.isJsxAttribute(property) && property.name.text === 'aria-hidden',
  )
  return attribute !== undefined
    && ts.isJsxAttribute(attribute)
    && attribute.initializer !== undefined
    && ts.isStringLiteral(attribute.initializer)
    && attribute.initializer.text === 'true'
    && /^[^\p{L}\p{N}]+$/u.test(text.text.trim())
}

function isTechnicalJsxText(text) {
  const value = text.text.trim()
  if (value === '@all') return true
  if (value !== '@' && value !== '#') return false
  const parent = text.parent
  if (!ts.isJsxElement(parent)) return false
  const index = parent.children.indexOf(text)
  const expression = parent.children[index + 1]
  if (expression === undefined || !ts.isJsxExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false
  if (value === '#') return expression.expression.name.text === 'sequence'
  const className = parent.openingElement.attributes.properties.find(property =>
    ts.isJsxAttribute(property) && property.name.text === 'className',
  )
  return expression.expression.name.text === 'name'
    && className !== undefined
    && ts.isJsxAttribute(className)
    && className.initializer !== undefined
    && ts.isStringLiteral(className.initializer)
    && className.initializer.text === 'dsh-agent-group-chip'
}

function isTechnicalJsxExpression(expression) {
  const node = expression.expression
  if (node === undefined) return false
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === '@all') {
    return hasLiteralClass(expression.parent, 'dsh-agent-group-chip')
  }
  if (!ts.isConditionalExpression(node)
    || !ts.isStringLiteral(node.whenTrue)
    || node.whenTrue.text !== '# '
    || !ts.isStringLiteral(node.whenFalse)
    || node.whenFalse.text !== '') return false
  return hasLiteralClass(expression.parent, 'dsh-agent-group-section-title')
    && isKindComparison(node.condition, 'group')
}

function hasLiteralClass(node, expected) {
  if (!ts.isJsxElement(node)) return false
  const attribute = node.openingElement.attributes.properties.find(property =>
    ts.isJsxAttribute(property) && property.name.text === 'className',
  )
  return attribute !== undefined
    && ts.isJsxAttribute(attribute)
    && attribute.initializer !== undefined
    && ts.isStringLiteral(attribute.initializer)
    && attribute.initializer.text === expected
}

function isKindComparison(node, expected) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false
  return ts.isPropertyAccessExpression(node.left)
    && node.left.name.text === 'kind'
    && ts.isStringLiteral(node.right)
    && node.right.text === expected
}

function report(source, node, category, message) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source))
  diagnostics.push({
    file: source.fileName,
    line: position.line + 1,
    column: position.character + 1,
    category,
    message,
  })
}
