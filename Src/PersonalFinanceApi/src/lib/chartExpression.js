import HttpError from "../models/httpError.model.js";

// Calculated chart lines: numbers, line names, + - * /, unary minus, parentheses, and the per-bucket
// aggregates over a line's points, e.g. avg(gdp) / max(cpi) * 100. first, last and middle take the point at that
// position in X order (middle: the earlier of the two middle points when the count is even).
export const AGGREGATES = ["sum", "avg", "median", "min", "max", "first", "last", "middle"];
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// What a calculated line may use, shown by the admin's (i) next to the expression (GET /v1/chart-expression-help).
// Keep it in step with the parser: a test checks every aggregate is listed and every example parses.
export const EXPRESSION_HELP = {
  summary: "A calculated line's value in each X bucket. A name is another line or series; null (no value) in any part gives no point, and division by zero gives no point.",
  entries: [
    { syntax: "gdp", kind: "name", description: "The line's value in this X bucket (after its aggregator, math and missing-value setting).", example: "gdp" },
    { syntax: "12.5, 1e3", kind: "number", description: "A number; decimals and exponents are allowed.", example: "1e3 / 4" },
    { syntax: "a + b, a - b", kind: "operator", description: "Add, subtract.", example: "brent - wti" },
    { syntax: "a * b, a / b", kind: "operator", description: "Multiply, divide (before + and -).", example: "price * 2 / 3" },
    { syntax: "-a", kind: "operator", description: "Negate.", example: "-delta" },
    { syntax: "( ... )", kind: "grouping", description: "Parentheses group a part to calculate first.", example: "(brent + wti) / 2" },
    { syntax: "sum(name)", kind: "aggregate", description: "Sum of the line's points in this X bucket.", example: "sum(rain)" },
    { syntax: "avg(name)", kind: "aggregate", description: "Mean of the line's points in this X bucket.", example: "avg(gdp) / max(cpi) * 100" },
    { syntax: "median(name)", kind: "aggregate", description: "Median of the line's points in this X bucket.", example: "median(price)" },
    { syntax: "min(name)", kind: "aggregate", description: "Smallest of the line's points in this X bucket.", example: "max(price) - min(price)" },
    { syntax: "max(name)", kind: "aggregate", description: "Largest of the line's points in this X bucket.", example: "max(price)" },
    { syntax: "first(name)", kind: "aggregate", description: "The line's first point in this X bucket, in X order.", example: "last(price) - first(price)" },
    { syntax: "last(name)", kind: "aggregate", description: "The line's last point in this X bucket, in X order.", example: "last(price)" },
    { syntax: "middle(name)", kind: "aggregate", description: "The line's middle point in this X bucket (the earlier of the two when the count is even).", example: "middle(price)" },
  ],
  limits: [
    "Aggregates take one line name, not an expression; aggregates of aggregates are not supported.",
    "Names are letters, digits and _, starting with a letter or _; the function names above cannot be line names.",
    "At most 500 characters.",
  ],
};

function fail(message) {
  return new HttpError(400, "ERR-CHART-EXPRESSION", message);
}

function tokenize(text) {
  const tokens = [];
  let position = 0;
  while (position < text.length) {
    const rest = text.slice(position);
    const space = rest.match(/^\s+/);
    if (space) {
      position += space[0].length;
      continue;
    }
    const number = rest.match(/^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]), position });
      position += number[0].length;
      continue;
    }
    const name = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) {
      tokens.push({ type: "name", value: name[0], position });
      position += name[0].length;
      continue;
    }
    if ("+-*/()".includes(rest[0])) {
      tokens.push({ type: rest[0], position });
      position += 1;
      continue;
    }
    throw fail(`Unexpected "${rest[0]}" at position ${position + 1}`);
  }
  tokens.push({ type: "end", position });
  return tokens;
}

// Recursive descent: expression = term (('+'|'-') term)*, term = unary (('*'|'/') unary)*,
// unary = '-' unary | primary, primary = number | name | aggregate '(' name ')' | '(' expression ')'.
export function parseExpression(text) {
  const source = String(text ?? "").trim();
  if (!source) throw fail("The expression is empty");
  if (source.length > 500) throw fail("Expressions are limited to 500 characters");
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = (type) => {
    const token = tokens[index];
    if (token.type !== type) {
      throw fail(type === "end" ? `Unexpected ${describe(token)} at position ${token.position + 1}` : `Expected "${type}" at position ${token.position + 1}`);
    }
    index += 1;
    return token;
  };
  const describe = (token) => (token.type === "name" || token.type === "number" ? `"${token.value}"` : token.type === "end" ? "end of expression" : `"${token.type}"`);

  function primary() {
    const token = peek();
    if (token.type === "number") {
      index += 1;
      return { type: "number", value: token.value };
    }
    if (token.type === "name") {
      index += 1;
      if (peek().type === "(") {
        if (!AGGREGATES.includes(token.value)) throw fail(`Unknown function ${token.value}(); use ${AGGREGATES.join(", ")}`);
        take("(");
        const argument = peek();
        if (argument.type === "name" && AGGREGATES.includes(argument.value) && tokens[index + 1].type === "(") {
          throw fail("Aggregates of aggregates are not supported");
        }
        if (argument.type !== "name" || tokens[index + 1].type !== ")") {
          throw fail(`${token.value}() takes one line name, e.g. ${token.value}(gdp)`);
        }
        index += 1;
        take(")");
        return { type: "aggregate", fn: token.value, line: argument.value };
      }
      return { type: "line", line: token.value };
    }
    if (token.type === "(") {
      index += 1;
      const inner = expression();
      take(")");
      return inner;
    }
    throw fail(`Unexpected ${describe(token)} at position ${token.position + 1}`);
  }

  function unary() {
    if (peek().type === "-") {
      index += 1;
      return { type: "negate", operand: unary() };
    }
    return primary();
  }

  function term() {
    let node = unary();
    while (peek().type === "*" || peek().type === "/") {
      const operator = take(peek().type).type;
      node = { type: "binary", operator, left: node, right: unary() };
    }
    return node;
  }

  function expression() {
    let node = term();
    while (peek().type === "+" || peek().type === "-") {
      const operator = take(peek().type).type;
      node = { type: "binary", operator, left: node, right: term() };
    }
    return node;
  }

  const tree = expression();
  take("end");
  return tree;
}

// The line names an expression uses, split by how they are used.
export function expressionReferences(tree) {
  const lines = new Set();
  const aggregated = new Set();
  const visit = (node) => {
    if (node.type === "line") lines.add(node.line);
    else if (node.type === "aggregate") aggregated.add(node.line);
    else if (node.type === "negate") visit(node.operand);
    else if (node.type === "binary") {
      visit(node.left);
      visit(node.right);
    }
  };
  visit(tree);
  return { lines: [...lines], aggregated: [...aggregated] };
}

// lookup.line(name) gives the line's value in this bucket, lookup.aggregate(fn, name) the aggregate of its
// points; null (no value) propagates, and division by zero gives null.
export function evaluateExpression(tree, lookup) {
  const visit = (node) => {
    switch (node.type) {
      case "number":
        return node.value;
      case "line":
        return lookup.line(node.line);
      case "aggregate":
        return lookup.aggregate(node.fn, node.line);
      case "negate": {
        const value = visit(node.operand);
        return value === null ? null : -value;
      }
      default: {
        const left = visit(node.left);
        const right = visit(node.right);
        if (left === null || right === null) return null;
        if (node.operator === "+") return left + right;
        if (node.operator === "-") return left - right;
        if (node.operator === "*") return left * right;
        return right === 0 ? null : left / right;
      }
    }
  };
  const result = visit(tree);
  return Number.isFinite(result) ? result : null;
}

export function isLineName(name) {
  return NAME_PATTERN.test(String(name || "")) && !AGGREGATES.includes(name);
}
