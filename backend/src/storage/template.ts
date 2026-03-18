/**
 * Lightweight template DSL for output file naming.
 *
 * Syntax:
 *   {var}          — variable expansion (empty string if undefined/null/blank)
 *   {var:N}        — zero-padded numeric variable (N = pad width)
 *   [ ... ]        — optional block: rendered only if at least one variable inside is non-empty
 *   \{ \} \[ \] \\ — escape sequences
 *
 * Nesting of optional blocks is NOT allowed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateVars = Record<string, string | number | undefined | null>;

interface TextNode {
  type: "text";
  value: string;
}

interface VarNode {
  type: "var";
  name: string;
  pad?: number;
}

interface OptionalNode {
  type: "optional";
  children: (TextNode | VarNode)[];
}

type Node = TextNode | VarNode | OptionalNode;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmpty(v: string | number | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseTemplate(template: string): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  const len = template.length;
  let insideOptional = false;
  let optionalChildren: (TextNode | VarNode)[] = [];

  function pushText(target: (TextNode | VarNode)[] | Node[], value: string) {
    if (value.length === 0) return;
    target.push({ type: "text", value });
  }

  while (i < len) {
    const ch = template[i];

    // Escape
    if (ch === "\\") {
      const next = template[i + 1];
      if (next === "{" || next === "}" || next === "[" || next === "]" || next === "\\") {
        const target = insideOptional ? optionalChildren : nodes;
        pushText(target, next);
        i += 2;
        continue;
      }
      // Unknown escape — keep as-is
      const target = insideOptional ? optionalChildren : nodes;
      pushText(target, ch);
      i += 1;
      continue;
    }

    // Variable
    if (ch === "{") {
      const close = template.indexOf("}", i + 1);
      if (close === -1) {
        throw new TemplateError(`Unclosed variable at position ${i}`);
      }
      const inner = template.slice(i + 1, close);
      const colonIdx = inner.indexOf(":");
      let name: string;
      let pad: number | undefined;
      if (colonIdx !== -1) {
        name = inner.slice(0, colonIdx);
        const padStr = inner.slice(colonIdx + 1);
        pad = parseInt(padStr, 10);
        if (isNaN(pad)) {
          throw new TemplateError(`Invalid pad width "${padStr}" in {${inner}}`);
        }
      } else {
        name = inner;
      }
      if (name.length === 0) {
        throw new TemplateError(`Empty variable name at position ${i}`);
      }
      const node: VarNode = { type: "var", name, ...(pad !== undefined && { pad }) };
      if (insideOptional) {
        optionalChildren.push(node);
      } else {
        nodes.push(node);
      }
      i = close + 1;
      continue;
    }

    // Optional block start
    if (ch === "[") {
      if (insideOptional) {
        throw new TemplateError(`Nested optional blocks are not allowed (position ${i})`);
      }
      insideOptional = true;
      optionalChildren = [];
      i += 1;
      continue;
    }

    // Optional block end
    if (ch === "]") {
      if (!insideOptional) {
        throw new TemplateError(`Unexpected ] at position ${i} (no matching [)`);
      }
      nodes.push({ type: "optional", children: optionalChildren });
      insideOptional = false;
      optionalChildren = [];
      i += 1;
      continue;
    }

    // Plain text — collect consecutive characters
    let text = "";
    while (i < len) {
      const c = template[i];
      if (c === "\\" || c === "{" || c === "[" || c === "]") break;
      text += c;
      i += 1;
    }
    const target = insideOptional ? optionalChildren : nodes;
    pushText(target, text);
  }

  if (insideOptional) {
    throw new TemplateError("Unclosed optional block (missing ])");
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function resolveVar(node: VarNode, vars: TemplateVars): string {
  const raw = vars[node.name];
  if (isEmpty(raw)) return "";
  if (node.pad !== undefined) {
    return String(raw).padStart(node.pad, "0");
  }
  return String(raw);
}

export function evaluateTemplate(nodes: Node[], vars: TemplateVars): string {
  let result = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result += node.value;
        break;
      case "var":
        result += resolveVar(node, vars);
        break;
      case "optional": {
        // Check if any variable in this block is non-empty
        const hasValue = node.children.some(
          (child) => child.type === "var" && !isEmpty(vars[child.name])
        );
        if (hasValue) {
          for (const child of node.children) {
            if (child.type === "text") {
              result += child.value;
            } else {
              result += resolveVar(child, vars);
            }
          }
        }
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export function renderTemplate(template: string, vars: TemplateVars): string {
  const nodes = parseTemplate(template);
  return evaluateTemplate(nodes, vars);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Validate a template string. Returns null if valid, or an error message. */
export function validateTemplate(template: string): string | null {
  try {
    parseTemplate(template);
    return null;
  } catch (e) {
    if (e instanceof TemplateError) return e.message;
    throw e;
  }
}
