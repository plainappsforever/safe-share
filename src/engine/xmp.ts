/**
 * Tolerant XMP reader (own small XML tokenizer, no DOM) and a compact writer used when a profile
 * keeps part of the XMP. Only simple and array properties are ever written back; structures are
 * reported but never re-serialised (a profile that keeps part of the XMP removes them — D29).
 */
import { makeField, describeXmp, XMP_NAMESPACES, type Field } from './catalog';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

export interface XmpProp {
  ns: string;
  /** Canonical prefix (catalogue) or the file's own prefix for unknown namespaces. */
  prefix: string;
  local: string;
  kind: 'simple' | 'array' | 'struct';
  arrayType?: 'Seq' | 'Bag' | 'Alt';
  values: string[];
  langs?: (string | undefined)[];
}

export interface Xmp {
  props: XmpProp[];
  /** False when no rdf:RDF could be found (garbage or compressed payload). */
  ok: boolean;
}

interface Node {
  name: string;
  attrs: [string, string][];
  children: Node[];
  text: string;
  ns: Map<string, string>;
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseTree(text: string): Node {
  const root: Node = { name: '#root', attrs: [], children: [], text: '', ns: new Map() };
  const stack: Node[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      top.text += text.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
    } else if (text.startsWith('</', lt)) {
      const e = text.indexOf('>', lt + 2);
      const name = text.slice(lt + 2, e < 0 ? n : e).trim();
      // Pop to the matching element (tolerates unclosed children).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
    } else {
      // Start tag: find its end, honouring quoted attribute values.
      let j = lt + 1;
      let quote = '';
      while (j < n) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      let body = text.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) {
        i = j + 1;
        continue;
      }
      const node: Node = { name: m[1], attrs: [], children: [], text: '', ns: new Map(top.ns) };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      const rest = body.slice(m[1].length);
      while ((a = re.exec(rest))) {
        const value = decodeEntities(a[3] ?? a[4] ?? '');
        if (a[1] === 'xmlns') node.ns.set('', value);
        else if (a[1].startsWith('xmlns:')) node.ns.set(a[1].slice(6), value);
        else node.attrs.push([a[1], value]);
      }
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

function split(name: string, scope: Map<string, string>): { ns: string; prefix: string; local: string } {
  const c = name.indexOf(':');
  const prefix = c < 0 ? '' : name.slice(0, c);
  const local = c < 0 ? name : name.slice(c + 1);
  const ns = scope.get(prefix) ?? '';
  return { ns, prefix: XMP_NAMESPACES[ns] ?? prefix, local };
}

function textOf(node: Node): string {
  return (node.text + node.children.map(textOf).join(' ')).trim();
}

/** Leaf "field=value" pairs of a structure, for display and signature needles. */
function flatten(node: Node, out: string[]): void {
  for (const [k, v] of node.attrs) {
    const { ns, local } = split(k, node.ns);
    if (ns !== RDF && v.trim()) out.push(`${local}=${v.trim()}`);
  }
  if (node.children.length === 0) {
    const t = node.text.trim();
    if (t) out.push(t);
    return;
  }
  for (const c of node.children) {
    const { ns, local } = split(c.name, c.ns);
    if (ns === RDF) flatten(c, out);
    else if (c.children.length === 0 && c.attrs.every(([k]) => split(k, c.ns).ns === RDF || k.startsWith('xml:'))) {
      const t = c.text.trim();
      if (t) out.push(`${local}=${t}`);
    } else flatten(c, out);
  }
}

export function parseXmp(text: string): Xmp {
  const root = parseTree(text);
  const props: XmpProp[] = [];
  let ok = false;
  const visit = (node: Node, inRdf: boolean) => {
    const { ns, local } = split(node.name, node.ns);
    if (ns === RDF && local === 'RDF') {
      ok = true;
      for (const c of node.children) visit(c, true);
      return;
    }
    if (inRdf && ns === RDF && local === 'Description') {
      for (const [k, v] of node.attrs) {
        const s = split(k, node.ns);
        if (s.ns === RDF || k.startsWith('xml:') || !s.ns) continue;
        props.push({ ns: s.ns, prefix: s.prefix, local: s.local, kind: 'simple', values: [v] });
      }
      for (const c of node.children) props.push(propOf(c));
      return;
    }
    for (const c of node.children) visit(c, inRdf);
  };
  visit(root, false);
  return { props, ok };
}

function propOf(el: Node): XmpProp {
  const s = split(el.name, el.ns);
  const base = { ns: s.ns, prefix: s.prefix, local: s.local };
  const resource = el.attrs.find(([k]) => split(k, el.ns).ns === RDF && split(k, el.ns).local === 'resource');
  if (resource) return { ...base, kind: 'simple', values: [resource[1]] };
  const container = el.children.find((c) => {
    const x = split(c.name, c.ns);
    return x.ns === RDF && (x.local === 'Seq' || x.local === 'Bag' || x.local === 'Alt');
  });
  if (container && el.children.length === 1) {
    const items = container.children.filter((c) => split(c.name, c.ns).local === 'li');
    const struct = items.some((li) => li.children.length > 0 || li.attrs.some(([k]) => !k.startsWith('xml:') && split(k, li.ns).ns !== RDF));
    if (struct) {
      const values: string[] = [];
      for (const li of items) flatten(li, values);
      return { ...base, kind: 'struct', values };
    }
    return {
      ...base,
      kind: 'array',
      arrayType: split(container.name, container.ns).local as 'Seq' | 'Bag' | 'Alt',
      values: items.map((li) => li.text.trim()),
      langs: items.map((li) => li.attrs.find(([k]) => k === 'xml:lang')?.[1]),
    };
  }
  const nonRdfAttrs = el.attrs.filter(([k]) => !k.startsWith('xml:') && split(k, el.ns).ns !== RDF);
  if (el.children.length > 0 || nonRdfAttrs.length > 0 || el.attrs.some(([k, v]) => k.endsWith(':parseType') && v === 'Resource')) {
    const values: string[] = [];
    flatten(el, values);
    return { ...base, kind: 'struct', values };
  }
  return { ...base, kind: 'simple', values: [textOf(el)] };
}

/** Catalogue fields for XMP properties. Needles include the stored (escaped) spelling of each value. */
export function xmpFields(x: Xmp): Field[] {
  return x.props.map((p) => {
    const d = describeXmp(p.prefix, p.local);
    const vals = p.kind === 'struct' ? p.values.map((v) => v.replace(/^[^=]*=/, '')) : p.values;
    const needles: string[] = [];
    for (const v of vals) {
      if (!v) continue;
      needles.push(v);
      const esc = escapeXml(v);
      if (esc !== v) needles.push(esc);
    }
    const value = p.values.join(p.kind === 'struct' ? '; ' : ', ');
    return makeField('xmp', `${p.prefix}:${p.local}`, d, value.length > 200 ? `${value.slice(0, 200)}…` : value, needles);
  });
}

const PACKET_HEAD = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>';
const PACKET_TAIL = '<?xpacket end="w"?>';

/** A valid XMP packet with no properties at all. */
export const EMPTY_XMP = `${PACKET_HEAD}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}"/></x:xmpmeta>${PACKET_TAIL}`;

/** Serialises simple/array properties into a compact packet (structures are never written). */
export function serializeXmp(props: XmpProp[]): string {
  const keep = props.filter((p) => p.kind !== 'struct' && p.ns);
  if (keep.length === 0) return EMPTY_XMP;
  const prefixes = new Map<string, string>();
  for (const p of keep) if (!prefixes.has(p.ns)) prefixes.set(p.ns, p.prefix && !/^(x|rdf|xml)$/.test(p.prefix) ? p.prefix : `ns${prefixes.size}`);
  const decl = [...prefixes].map(([ns, pre]) => ` xmlns:${pre}="${escapeXml(ns)}"`).join('');
  const attrs: string[] = [];
  const elems: string[] = [];
  for (const p of keep) {
    const q = `${prefixes.get(p.ns)}:${p.local}`;
    if (p.kind === 'simple') attrs.push(` ${q}="${escapeXml(p.values[0] ?? '')}"`);
    else {
      const t = p.arrayType ?? 'Seq';
      const lis = p.values
        .map((v, i) => {
          const lang = p.langs?.[i] ?? (t === 'Alt' ? 'x-default' : undefined);
          return `<rdf:li${lang ? ` xml:lang="${escapeXml(lang)}"` : ''}>${escapeXml(v)}</rdf:li>`;
        })
        .join('');
      elems.push(`<${q}><rdf:${t}>${lis}</rdf:${t}></${q}>`);
    }
  }
  const desc = elems.length
    ? `<rdf:Description rdf:about=""${decl}${attrs.join('')}>${elems.join('')}</rdf:Description>`
    : `<rdf:Description rdf:about=""${decl}${attrs.join('')}/>`;
  return `${PACKET_HEAD}<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">${desc}</rdf:RDF></x:xmpmeta>${PACKET_TAIL}`;
}

/** Pads a packet to exactly `size` bytes with spaces before the trailer (for in-place HEIF blanking). */
export function padPacket(packet: string, size: number): string | null {
  const body = packet.endsWith(PACKET_TAIL) ? packet.slice(0, -PACKET_TAIL.length) : packet;
  const need = size - utf8Length(body) - PACKET_TAIL.length;
  if (need < 0) return null;
  return body + ' '.repeat(need) + PACKET_TAIL;
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export const XMP_JPEG_ID = 'http://ns.adobe.com/xap/1.0/\0';
export const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';

/**
 * Keeps the properties whose field `keep` accepts; structures are never written back (D29), so a
 * structure is reported as removed even when the profile would keep it. Null when nothing is kept.
 */
export function rebuildXmp(props: XmpProp[], keep: (f: Field) => boolean): { packet: string | null; kept: Field[] } {
  const fields = xmpFields({ props, ok: true });
  const keptProps: XmpProp[] = [];
  const kept: Field[] = [];
  props.forEach((p, i) => {
    if (p.kind !== 'struct' && p.ns && keep(fields[i])) {
      keptProps.push(p);
      kept.push(fields[i]);
    }
  });
  return { packet: keptProps.length ? serializeXmp(keptProps) : null, kept };
}
