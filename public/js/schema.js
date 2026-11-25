// Minimal JSON Schema (draft 2020-12) validator covering the keywords used in /data/schemas:
// type, const, enum, properties, required, additionalProperties, patternProperties, items,
// minItems, minimum, maximum, pattern, oneOf, anyOf, allOf, $ref (#/$defs/...), format (date-time).
const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const typeOk = (v, t) => {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
};
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function validate(schema, value, root = schema) {
  const errors = [];
  walk(schema, value, "", root, errors);
  return { valid: errors.length === 0, errors };
}

function resolve(ref, root) {
  if (!ref.startsWith("#/")) throw new Error("Unsupported $ref " + ref);
  return ref.slice(2).split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function walk(s, v, path, root, errors) {
  if (s === true || s === undefined) return;
  if (s === false) { errors.push(`${path || "/"}: not allowed`); return; }
  if (s.$ref) walk(resolve(s.$ref, root), v, path, root, errors);
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t) => typeOk(v, t))) { errors.push(`${path || "/"}: expected ${ts.join("|")}, got ${typeOf(v)}`); return; }
  }
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${path || "/"}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path || "/"}: must be one of ${s.enum.join(", ")}`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`);
  }
  if (typeof v === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    if (s.format === "date-time" && !DT.test(v)) errors.push(`${path}: not an ISO 8601 date-time with offset`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: needs at least ${s.minItems} item(s)`);
    if (s.items) v.forEach((x, i) => walk(s.items, x, `${path}/${i}`, root, errors));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const r of s.required || []) if (!(r in v)) errors.push(`${path || "/"}: missing required "${r}"`);
    const props = s.properties || {};
    const pats = Object.entries(s.patternProperties || {}).map(([p, sch]) => [new RegExp(p, "u"), sch]);
    for (const [k, x] of Object.entries(v)) {
      let matched = false;
      if (k in props) { matched = true; walk(props[k], x, `${path}/${k}`, root, errors); }
      for (const [re, sch] of pats) if (re.test(k)) { matched = true; walk(sch, x, `${path}/${k}`, root, errors); }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) errors.push(`${path || "/"}: unexpected property "${k}"`);
        else walk(s.additionalProperties, x, `${path}/${k}`, root, errors);
      }
    }
  }
  if (s.allOf) for (const sub of s.allOf) walk(sub, v, path, root, errors);
  const sub = (x) => { const e = []; walk(x, v, path, root, e); return e; };
  if (s.anyOf && !s.anyOf.some((x) => sub(x).length === 0)) errors.push(`${path || "/"}: matches none of anyOf`);
  if (s.oneOf) {
    const results = s.oneOf.map((x) => ({ errors: sub(x) }));
    const n = results.filter((r) => r.errors.length === 0).length;
    if (n !== 1) {
      if (n === 0) {
        // Report the errors of the closest branch (fewest errors) to keep messages useful.
        const best = results.reduce((a, b) => (b.errors.length < a.errors.length ? b : a));
        errors.push(...best.errors.map((e) => e));
        if (!best.errors.length) errors.push(`${path || "/"}: matches none of oneOf`);
      } else errors.push(`${path || "/"}: matches more than one of oneOf`);
    }
  }
}
