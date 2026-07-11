import glob, re, json, os, html, sys, argparse
from collections import defaultdict

argp = argparse.ArgumentParser(description="Собрать data/graph.json и data/notes.json из Obsidian-вики для «Сада знаний».")
argp.add_argument("--vault", default="wiki13", help="Путь к папке вики (та, что содержит posts/, concepts/, persons/)")
argp.add_argument("--out", default="data", help="Папка, куда сохранить graph.json и notes.json")
args = argp.parse_args()

ROOT = args.vault
OUT = args.out
EXCLUDE_IDS = {"00-Индекс", "00-Указатель", "persons/00-Персоналии"}
TYPES = ["posts", "concepts", "persons"]

def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()

id_set = set()
id_map = {}
files_by_id = {}

for t in TYPES:
    for fp in glob.glob(os.path.join(ROOT, t, "*.md")):
        base = os.path.basename(fp)[:-3]
        nid = f"{t}/{base}"
        if nid in EXCLUDE_IDS:
            continue
        id_set.add(nid)
        files_by_id[nid] = fp
        id_map[nid.lower()] = nid

WIKILINK_RE = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]')
DATE_RE = re.compile(r'^(\d{2})\.(\d{2})\.(\d{4})_')

def normalize_target(raw):
    raw = raw.strip()
    if raw.startswith("./"):
        raw = raw[2:]
    if raw.lower().endswith(".md"):
        raw = raw[:-3]
    return raw

def resolve(raw):
    norm = normalize_target(raw)
    if norm in EXCLUDE_IDS:
        return None
    if norm in id_set:
        return norm
    key = norm.lower()
    if key in id_map:
        return id_map[key]
    if "/" not in norm:
        for t in TYPES:
            cand = f"{t}/{norm}"
            if cand in id_set:
                return cand
            if cand.lower() in id_map:
                return id_map[cand.lower()]
    return None

# ---------- markdown -> html renderer ----------
def render_inline(text, current_id):
    # escape html first
    text = html.escape(text, quote=False)

    # wikilinks [[target|label]] or [[target]]
    def wl_sub(m):
        target_raw = html.unescape(m.group(1))
        label = m.group(2)
        label = html.unescape(label) if label else target_raw
        label = html.escape(label, quote=False)
        resolved = resolve(target_raw)
        if resolved and resolved != current_id:
            return f'<a href="#" class="wikilink" data-id="{html.escape(resolved, quote=True)}">{label}</a>'
        return f'<span class="wikilink unresolved">{label}</span>'

    text = WIKILINK_RE.sub(wl_sub, text)

    # markdown links [text](url)  (avoid matching already-produced <a> tags, safe since escape happened before)
    text = re.sub(r'(?<!\!)\[([^\]]+)\]\((https?://[^\s)]+)\)',
                   r'<a href="\2" target="_blank" rel="noopener">\1</a>', text)

    # bold **text**
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    # italic *text*
    text = re.sub(r'(?<!\*)\*([^*\n]+)\*(?!\*)', r'<em>\1</em>', text)

    # bare urls (not already inside href="...") -- simple heuristic: skip if preceded by " or >
    def url_sub(m):
        url = m.group(0)
        disp = url if len(url) <= 60 else url[:57] + "…"
        return f'<a href="{url}" target="_blank" rel="noopener">{disp}</a>'
    text = re.sub(r'(?<!["\'>])https?://[^\s<]+', url_sub, text)

    return text

def render_markdown(md, current_id):
    lines = md.split("\n")
    out = []
    list_buf = []
    quote_buf = []
    para_buf = []

    def flush_list():
        if list_buf:
            out.append("<ul>" + "".join(f"<li>{render_inline(x, current_id)}</li>" for x in list_buf) + "</ul>")
            list_buf.clear()

    def flush_quote():
        if quote_buf:
            out.append("<blockquote>" + "<br>".join(render_inline(x, current_id) for x in quote_buf) + "</blockquote>")
            quote_buf.clear()

    def flush_para():
        if para_buf:
            out.append("<p>" + " ".join(render_inline(x, current_id) for x in para_buf) + "</p>")
            para_buf.clear()

    def flush_all():
        flush_list(); flush_quote(); flush_para()

    for raw_line in lines:
        line = raw_line.rstrip()
        if "← " in line:
            continue  # nav footer junk
        s = line.strip()

        if s == "":
            flush_all()
            continue

        m = re.match(r'^(#{1,6})\s+(.*)$', s)
        if m:
            flush_all()
            level = min(len(m.group(1)) + 1, 6)  # shift down (h1 title shown separately in UI)
            out.append(f"<h{level}>{render_inline(m.group(2), current_id)}</h{level}>")
            continue

        if re.match(r'^-{3,}$', s):
            flush_all()
            out.append("<hr>")
            continue

        if s.startswith("> "):
            flush_list(); flush_para()
            quote_buf.append(s[2:])
            continue

        if s.startswith("- "):
            flush_quote(); flush_para()
            list_buf.append(s[2:])
            continue

        flush_list(); flush_quote()
        para_buf.append(s)

    flush_all()
    return "\n".join(out)

# ---------- build graph ----------
nodes = {}
edges_set = set()

for nid, fp in files_by_id.items():
    txt = read(fp)
    t = nid.split("/", 1)[0]
    base = os.path.basename(fp)[:-3]

    title_match = re.search(r'^#\s+(.+)$', txt, re.M)
    title = title_match.group(1).strip() if title_match else base

    date = None
    dm = DATE_RE.match(base)
    if dm:
        date = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}"

    tags = sorted(set(re.findall(r'#([а-яА-ЯёЁa-zA-Z0-9_]+)', txt)))

    links = set()
    for m in WIKILINK_RE.finditer(txt):
        resolved = resolve(m.group(1))
        if resolved and resolved != nid:
            links.add(resolved)

    nodes[nid] = {
        "id": nid, "type": t, "title": title, "date": date, "tags": tags,
        "links": sorted(links), "raw": txt,
    }
    for l in links:
        edges_set.add(tuple(sorted((nid, l))))

degree = defaultdict(int)
backlinks = defaultdict(list)
for a, b in edges_set:
    degree[a] += 1
    degree[b] += 1
for nid, n in nodes.items():
    for l in n["links"]:
        backlinks[l].append(nid)

graph_nodes = [{"id": nid, "type": n["type"], "title": n["title"], "date": n["date"], "deg": degree.get(nid, 0)}
               for nid, n in nodes.items()]
graph_edges = [{"source": a, "target": b} for a, b in sorted(edges_set)]

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "graph.json"), "w", encoding="utf-8") as f:
    json.dump({"nodes": graph_nodes, "edges": graph_edges}, f, ensure_ascii=False, separators=(",", ":"))

notes_out = {}
for nid, n in nodes.items():
    notes_out[nid] = {
        "title": n["title"],
        "type": n["type"],
        "date": n["date"],
        "tags": n["tags"],
        "links": n["links"],
        "backlinks": sorted(set(backlinks.get(nid, []))),
        "html": render_markdown(n["raw"], nid),
    }

with open(os.path.join(OUT, "notes.json"), "w", encoding="utf-8") as f:
    json.dump(notes_out, f, ensure_ascii=False, separators=(",", ":"))

print("nodes:", len(graph_nodes), "edges:", len(graph_edges))
print("graph.json:", os.path.getsize(os.path.join(OUT, "graph.json")))
print("notes.json:", os.path.getsize(os.path.join(OUT, "notes.json")))
