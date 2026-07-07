"""code-graph Python analyzer helper.

A long-lived subprocess driven by server/python-analyzer.ts over newline-
delimited JSON on stdio. stdout carries ONLY protocol frames (one JSON object
per line); all diagnostics go to stderr.

It produces the SAME generic wire shapes the TypeScript (ts-morph) analyzer
emits — FileNode / AstNode / FileAstResponse / ImportEdge / SemanticEdge — so
the client renders Python identically. The node tree comes from the stdlib
`ast` module; cross-symbol resolution (calls / class bases) comes from Jedi.

Invariants shared with the TS side:
  * fileId = posix relative path from root (never contains '#').
  * AST id = f"{fileId}#{seq}", seq reset per file, assigned depth-first
    pre-order so ids are stable across re-walks of an unchanged file.
  * edge ids: imports f"{fromId}->{toId}@{pos}", semantic f"{fromId}~{kind}~{toId}".
"""

import ast
import json
import os
import re
import select
import subprocess
import sys
import traceback
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import jedi
except Exception:  # pragma: no cover - the Node side probes for jedi first
    jedi = None


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# --- AST node kinds handled specially ------------------------------------

# Operator AST nodes are folded into the parent's `op` string instead of
# emitting a box (mirrors the TS extractor's operator handling).
_OPERATOR_BASES = (ast.operator, ast.boolop, ast.unaryop, ast.cmpop)

# Structural wrappers with no value of their own — emit their children in
# place (the TS PASSTHROUGH_KINDS analogue).
_PASSTHROUGH = {"arguments", "keyword", "comprehension", "withitem", "Expr"}

# Expression-context markers (Load/Store/Del) — skipped entirely.
_SKIP = {"Load", "Store", "Del", "Starred"}

_OP_TEXT = {
    "Add": "+", "Sub": "-", "Mult": "*", "Div": "/", "FloorDiv": "//",
    "Mod": "%", "Pow": "**", "LShift": "<<", "RShift": ">>", "BitOr": "|",
    "BitXor": "^", "BitAnd": "&", "MatMult": "@",
    "And": "and", "Or": "or", "Not": "not", "Invert": "~", "UAdd": "+", "USub": "-",
    "Eq": "==", "NotEq": "!=", "Lt": "<", "LtE": "<=", "Gt": ">", "GtE": ">=",
    "Is": "is", "IsNot": "is not", "In": "in", "NotIn": "not in",
}


def op_text(op_node):
    return _OP_TEXT.get(type(op_node).__name__)


# --- offset helpers -------------------------------------------------------


def line_start_offsets(source):
    """Char offset (into the full string) where each 1-based line begins."""
    starts = [0]
    for i, ch in enumerate(source):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def byte_col_to_char(source, line_starts, lineno, byte_col):
    """ast col_offset is a UTF-8 byte offset within the line; convert it to a
    character index so our char offsets (and Jedi columns) line up."""
    if lineno is None or lineno - 1 >= len(line_starts):
        return 0
    line_begin = line_starts[lineno - 1]
    line_end = (
        line_starts[lineno] - 1 if lineno < len(line_starts) else len(source)
    )
    line = source[line_begin:line_end]
    if byte_col <= 0:
        return 0
    prefix = line.encode("utf-8")[:byte_col].decode("utf-8", errors="replace")
    return len(prefix)


# --- per-file parse + node mapping ---------------------------------------


class FileData:
    __slots__ = (
        "file_id", "abs_path", "source", "tree", "nodes", "file_node",
        "def_index", "alias_index", "call_sites", "class_bases", "imports",
        "module_name",
    )

    def __init__(self, file_id, abs_path, source):
        self.file_id = file_id
        self.abs_path = abs_path
        self.source = source
        self.tree = ast.parse(source, filename=abs_path)
        self.nodes = []
        # (line, name) -> astId for FunctionDef/ClassDef/module-level assigns.
        self.def_index = {}
        # (line, name) -> astId for import aliases (the local binding).
        self.alias_index = {}
        # call sites: {"astId", "line", "col", "name"} (callee end position).
        self.call_sites = []
        # class bases: {"astId" (subclass), "line", "col", "name"}.
        self.class_bases = []
        # import statements: {"astId", "module", "level", "names", "char"}.
        self.imports = []
        self.module_name = module_name_for(file_id)
        self.file_node = build_file_node(file_id, abs_path, source)
        self._walk()

    def ast_response(self):
        root_id = self.nodes[0]["id"] if self.nodes else f"{self.file_id}#0"
        return {"fileId": self.file_id, "rootId": root_id, "nodes": self.nodes}

    def _walk(self):
        source = self.source
        line_starts = line_start_offsets(source)
        seq = [0]
        inlined = set()  # id() of python ast nodes whose text was inlined

        def char_off(lineno, byte_col):
            if lineno is None:
                return 0
            base = line_starts[lineno - 1] if lineno - 1 < len(line_starts) else 0
            return base + byte_col_to_char(source, line_starts, lineno, byte_col)

        def node_span(node):
            lineno = getattr(node, "lineno", None)
            if lineno is None:
                return 0, len(source)
            start = char_off(lineno, getattr(node, "col_offset", 0))
            end_lineno = getattr(node, "end_lineno", lineno)
            end_col = getattr(node, "end_col_offset", getattr(node, "col_offset", 0))
            end = char_off(end_lineno, end_col)
            return start, end

        # Dotted attribute/name label, inlining the inner nodes so they don't
        # re-emit (the TS access-chain analogue).
        def dotted(node):
            if isinstance(node, ast.Name):
                return node.id
            if isinstance(node, ast.Attribute):
                base = dotted(node.value)
                return f"{base}.{node.attr}" if base is not None else node.attr
            if isinstance(node, ast.Call):
                inner = dotted(node.func)
                return inner
            return None

        def mark_inlined(node):
            for d in ast.walk(node):
                inlined.add(id(d))

        def add(node, kind, name, extra=None):
            astid = f"{self.file_id}#{seq[0]}"
            seq[0] += 1
            start, end = node_span(node)
            rec = {
                "id": astid,
                "parentId": None,  # set by caller
                "syntaxKind": kind,
                "name": name,
                "start": start,
                "end": end,
            }
            if extra:
                rec.update(extra)
            self.nodes.append(rec)
            return rec, astid

        def add_synthetic(kind, name, start, end):
            astid = f"{self.file_id}#{seq[0]}"
            seq[0] += 1
            rec = {
                "id": astid, "parentId": None, "syntaxKind": kind,
                "name": name, "start": start, "end": end,
            }
            self.nodes.append(rec)
            return rec, astid

        # Wrap a function body's statement list in a synthetic `Block` so the
        # body collapses to `{…}` by default and reuses the TS Block rendering
        # (Python has no Block node — bodies are bare statement lists).
        def wrap_block(body, parent_id):
            if not body:
                return
            bstart = char_off(body[0].lineno, getattr(body[0], "col_offset", 0))
            last = body[-1]
            bend = char_off(
                getattr(last, "end_lineno", last.lineno),
                getattr(last, "end_col_offset", 0),
            )
            brec, bid = add_synthetic("Block", None, bstart, bend)
            brec["parentId"] = parent_id
            for stmt in body:
                visit(stmt, bid, False)

        def callee_end(func):
            """(line, char_col) just inside the callee name, for Jedi goto."""
            line = getattr(func, "end_lineno", getattr(func, "lineno", 1))
            bcol = getattr(func, "end_col_offset", getattr(func, "col_offset", 1))
            col = byte_col_to_char(source, line_starts, line, bcol)
            return line, max(col - 1, 0)

        # name position for resolution index entries
        def name_pos(node):
            return getattr(node, "lineno", None)

        all_names = collect_dunder_all(self.tree)

        def visit(node, parent_id, top_level):
            kind = type(node).__name__
            if kind in _SKIP or isinstance(node, _OPERATOR_BASES):
                return
            if id(node) in inlined:
                return

            # Passthrough wrappers: emit children in place. For `arguments`,
            # emit only the parameter (`arg`) children — defaults/annotations
            # are folded into the param labels, not separate boxes.
            if kind in _PASSTHROUGH:
                for child in ast.iter_child_nodes(node):
                    if kind == "arguments" and not isinstance(child, ast.arg):
                        continue
                    visit(child, parent_id, top_level)
                return

            # Python params emit as `Parameter` so they reuse the TS function
            # signature layout (which groups children of kind 'Parameter').
            emit_kind = "Parameter" if kind == "arg" else kind
            name = None
            extra = {}

            if kind in ("FunctionDef", "AsyncFunctionDef"):
                name = node.name
                sig = function_signature(node)
                if sig:
                    extra["signature"] = sig
                rt = annotation_text(getattr(node, "returns", None))
                if rt:
                    extra["returnType"] = rt
                # The return annotation is baked into the signature — don't
                # also emit it as a child box.
                if getattr(node, "returns", None) is not None:
                    mark_inlined(node.returns)
                pv = first_body_line(source, node)
                if pv:
                    extra["preview"] = pv
            elif kind == "ClassDef":
                name = node.name
                bases = [dotted(b) for b in node.bases]
                bases = [b for b in bases if b]
                if bases:
                    extra["extendsName"] = ", ".join(bases)
                # Bases are captured in extendsName (+ resolved for edges via
                # class_bases below) — don't emit them as child boxes.
                for b in node.bases:
                    mark_inlined(b)
                pv = first_body_line(source, node)
                if pv:
                    extra["preview"] = pv
            elif kind == "Attribute":
                name = dotted(node)
                mark_inlined(node)
            elif kind == "Name":
                name = node.id
            elif kind == "Constant":
                name = constant_label(node.value)
            elif kind == "Call":
                callee = dotted(node.func) or "call"
                name = f"▷ {callee}"  # ▷ marker, matches client splitCallMarker
                mark_inlined(node.func)
            elif kind in ("Import", "ImportFrom"):
                name = None  # tinted; the alias children carry names
            elif kind == "alias":
                name = node.asname or node.name
            elif kind == "arg":
                ann = annotation_text(getattr(node, "annotation", None))
                name = f"{node.arg}: {ann}" if ann else node.arg
                if getattr(node, "annotation", None) is not None:
                    mark_inlined(node.annotation)
            elif kind == "ExceptHandler":
                parts = ["except"]
                if node.type is not None:
                    t = annotation_text(node.type)
                    if t:
                        parts.append(t)
                    mark_inlined(node.type)
                if node.name:
                    parts.append(f"as {node.name}")
                name = " ".join(parts)
            elif kind == "BinOp":
                t = op_text(node.op)
                if t:
                    extra["op"] = t
            elif kind == "AugAssign":
                t = op_text(node.op)
                extra["op"] = (t + "=") if t else "="
            elif kind == "BoolOp":
                t = op_text(node.op)
                if t:
                    extra["op"] = t
            elif kind == "UnaryOp":
                t = op_text(node.op)
                if t:
                    extra["op"] = t
            elif kind == "Compare":
                ops = [op_text(o) for o in node.ops]
                ops = [o for o in ops if o]
                if ops:
                    extra["op"] = " ".join(ops)
            elif kind == "Assign":
                extra["op"] = "="
                tname = assign_target_name(node)
                if tname:
                    name = tname
                # A single simple `x = ...` target is captured by the name;
                # don't also emit the bare target box (mirrors TS's name slot).
                if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    mark_inlined(node.targets[0])
            elif kind == "AnnAssign":
                tname = dotted(node.target)
                ann = annotation_text(node.annotation)
                if tname:
                    name = tname
                if ann:
                    extra["signature"] = f": {ann}"
                mark_inlined(node.target)
                if node.annotation is not None:
                    mark_inlined(node.annotation)

            # Module-level export heuristic.
            if top_level and kind in (
                "FunctionDef", "AsyncFunctionDef", "ClassDef", "Assign", "AnnAssign",
            ):
                exported = is_exported(name, all_names)
                if exported:
                    extra["exported"] = True

            rec, astid = add(node, emit_kind, name, extra)
            rec["parentId"] = parent_id

            # Resolution indexes.
            if kind in ("FunctionDef", "AsyncFunctionDef", "ClassDef") and name:
                self.def_index[(node.lineno, node.name)] = astid
            if kind in ("Assign", "AnnAssign") and name and name_pos(node):
                self.def_index[(node.lineno, name)] = astid
            if kind == "alias":
                local = node.asname or node.name.split(".")[0]
                ln = getattr(node, "lineno", None)
                if ln is not None:
                    self.alias_index[(ln, local)] = astid
            if kind == "Call":
                line, col = callee_end(node.func)
                self.call_sites.append(
                    {"astId": astid, "line": line, "col": col,
                     "name": last_name(node.func)}
                )
            if kind == "ClassDef":
                for b in node.bases:
                    bl = getattr(b, "end_lineno", getattr(b, "lineno", None))
                    if bl is None:
                        continue
                    bcol = byte_col_to_char(
                        source, line_starts, bl,
                        getattr(b, "end_col_offset", getattr(b, "col_offset", 1)),
                    )
                    self.class_bases.append(
                        {"astId": astid, "line": bl, "col": max(bcol - 1, 0),
                         "name": last_name(b)}
                    )
            if kind in ("Import", "ImportFrom"):
                self.imports.append(self._import_record(node, astid, char_off))

            # Recurse. Decorators first (rendered above the def), then the rest.
            child_top = top_level and kind == "Module"
            decorators = getattr(node, "decorator_list", [])
            for dec in decorators:
                drec, did = add(dec, "Decorator", "@" + (dotted(dec) or last_name(dec) or ""))
                drec["parentId"] = astid
                mark_inlined(dec)

            # Functions: params as direct children, body wrapped in a Block so
            # it collapses to `{…}` by default (mirrors the TS function shape).
            if kind in ("FunctionDef", "AsyncFunctionDef"):
                visit(node.args, astid, False)
                wrap_block(node.body, astid)
                return

            for child in ast.iter_child_nodes(node):
                if child in decorators:
                    continue
                visit(child, astid, child_top)

        # Root module node.
        root_rec, root_id = add(self.tree, "Module", None)
        root_rec["parentId"] = None
        for child in ast.iter_child_nodes(self.tree):
            visit(child, root_id, True)

    def _import_record(self, node, astid, char_off):
        char = char_off(getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
        if isinstance(node, ast.Import):
            return {
                "astId": astid, "char": char, "level": 0,
                "modules": [a.name for a in node.names],
            }
        # ImportFrom
        return {
            "astId": astid, "char": char, "level": node.level or 0,
            "module": node.module, "names": [a.name for a in node.names],
        }


# --- small node helpers ---------------------------------------------------


def last_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return last_name(node.func)
    return None


def assign_target_name(node):
    if not node.targets:
        return None
    t = node.targets[0]
    if isinstance(t, ast.Name):
        return t.id
    if isinstance(t, ast.Attribute):
        return t.attr
    return None


def annotation_text(node):
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def function_signature(node):
    try:
        args = ast.unparse(node.args)
    except Exception:
        args = ""
    ret = annotation_text(getattr(node, "returns", None))
    sig = f"({args})"
    if ret:
        sig += f": {ret}"
    return sig


def constant_label(value):
    if isinstance(value, str):
        s = value if len(value) <= 24 else value[:23] + "…"
        return '"' + s.replace("\n", " ") + '"'
    if value is None:
        return "None"
    if value is True:
        return "True"
    if value is False:
        return "False"
    return repr(value)


def first_body_line(source, node):
    body = getattr(node, "body", None)
    if not body:
        return None
    first = body[0]
    ln = getattr(first, "lineno", None)
    if ln is None:
        return None
    lines = source.splitlines()
    if ln - 1 >= len(lines):
        return None
    text = lines[ln - 1].strip()
    return text[:60] + ("…" if len(text) > 60 else "") if text else None


def collect_dunder_all(tree):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__":
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        out = set()
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                out.add(elt.value)
                        return out
    return None


def is_exported(name, all_names):
    if name is None:
        return False
    if all_names is not None:
        return name in all_names
    return not name.startswith("_")


def module_name_for(file_id):
    p = file_id[:-3] if file_id.endswith(".py") else file_id
    p = p[:-9] if p.endswith("/__init__") else p
    return p.replace("/", ".")


def build_file_node(file_id, abs_path, source):
    return {
        "id": file_id,
        "kind": "file",
        "relativePath": file_id,
        "absolutePath": abs_path,
        "sizeBytes": len(source.encode("utf-8")),
        "lineCount": source.count("\n") + 1 if source else 0,
    }


# --- pyright LSP client --------------------------------------------------


def _uri(abs_path):
    return Path(abs_path).as_uri()


def _path_from_uri(uri):
    return unquote(urlparse(uri).path)


class PyrightClient:
    """A minimal synchronous LSP client driving pyright's language server for
    high-precision goto-definition. Speaks JSON-RPC with Content-Length framing
    over the server's stdio. Single-threaded: each request reads messages until
    its response arrives, replying to any server→client request so the server
    never blocks. Any failure raises so the caller can fall back to Jedi."""

    def __init__(self, argv, root):
        # bufsize=0 → raw FileIO streams, so select() on stdout never misses
        # bytes sitting in a Python-side buffer (a classic select+BufferedReader
        # deadlock on larger payloads).
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self.next_id = 1
        self.root = root
        self._buf = b""
        self._initialize()

    def _send(self, msg):
        data = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(data)}\r\n\r\n".encode("ascii")
        self.proc.stdin.write(header + data)
        self.proc.stdin.flush()

    def _read_message(self, timeout):
        """Read one framed JSON message, or None on timeout / EOF."""
        out = self.proc.stdout
        while b"\r\n\r\n" not in self._buf:
            if timeout is not None:
                r, _, _ = select.select([out], [], [], timeout)
                if not r:
                    return None
            chunk = out.read1(65536) if hasattr(out, "read1") else out.read(65536)
            if not chunk:
                return None
            self._buf += chunk
        head, _, rest = self._buf.partition(b"\r\n\r\n")
        m = re.search(rb"Content-Length:\s*(\d+)", head, re.I)
        if not m:
            self._buf = rest
            return None
        length = int(m.group(1))
        while len(rest) < length:
            if timeout is not None:
                r, _, _ = select.select([out], [], [], timeout)
                if not r:
                    self._buf = rest
                    return None
            chunk = out.read1(65536) if hasattr(out, "read1") else out.read(65536)
            if not chunk:
                return None
            rest += chunk
        body, self._buf = rest[:length], rest[length:]
        try:
            return json.loads(body.decode("utf-8"))
        except Exception:
            return None

    def _request(self, method, params, timeout=15.0):
        rid = self.next_id
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        while True:
            msg = self._read_message(timeout)
            if msg is None:
                raise RuntimeError(f"pyright request '{method}' timed out / EOF")
            # Server→client request: answer so the server doesn't block.
            if "id" in msg and "method" in msg:
                if msg["method"] == "workspace/configuration":
                    items = (msg.get("params") or {}).get("items", [])
                    result = [{} for _ in items]
                else:
                    result = None
                self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
                continue
            if "id" in msg and msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"pyright error: {msg['error']}")
                return msg.get("result")
            # Notification or unrelated response — ignore.

    def _notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _initialize(self):
        self._request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": _uri(self.root),
                "workspaceFolders": [{"uri": _uri(self.root), "name": "root"}],
                # Minimal capabilities — deliberately NOT advertising
                # configuration/dynamic registration so pyright doesn't fire
                # server→client requests we'd have to fully service.
                "capabilities": {
                    "textDocument": {
                        "definition": {"linkSupport": True},
                    },
                    "workspace": {},
                },
            },
            timeout=30.0,
        )
        self._notify("initialized", {})

    def did_open(self, abs_path, source):
        self._notify(
            "textDocument/didOpen",
            {"textDocument": {"uri": _uri(abs_path), "languageId": "python", "version": 1, "text": source}},
        )

    def did_close(self, abs_path):
        self._notify("textDocument/didClose", {"textDocument": {"uri": _uri(abs_path)}})

    def definition(self, abs_path, line0, char0):
        """Return [(abs_path, line0, char0)] definition locations for a position."""
        result = self._request(
            "textDocument/definition",
            {"textDocument": {"uri": _uri(abs_path)}, "position": {"line": line0, "character": char0}},
            timeout=15.0,
        )
        if not result:
            return []
        items = result if isinstance(result, list) else [result]
        out = []
        for it in items:
            if "targetUri" in it:  # LocationLink
                uri = it.get("targetUri")
                rng = it.get("targetSelectionRange") or it.get("targetRange")
            else:  # Location
                uri = it.get("uri")
                rng = it.get("range")
            if uri and rng:
                out.append((_path_from_uri(uri), rng["start"]["line"], rng["start"]["character"]))
        return out

    def close(self):
        try:
            self._notify("exit", None)
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass


# --- the analyzer state machine ------------------------------------------


class Analyzer:
    def __init__(self):
        self.root = None
        self.files = {}  # fileId -> FileData
        self.module_to_file = {}  # module name -> fileId
        self.jedi_project = None
        self.pyright = None  # PyrightClient | None — precision resolver

    # ---- discovery + parse ----

    def discover(self):
        out = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not excluded_dir(d)]
            for fn in filenames:
                if fn.endswith(".py") or fn.endswith(".pyi"):
                    abs_path = os.path.join(dirpath, fn)
                    out.append(abs_path)
        return out

    def file_id_of(self, abs_path):
        return os.path.relpath(abs_path, self.root).replace(os.sep, "/")

    def parse_file(self, abs_path):
        file_id = self.file_id_of(abs_path)
        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                source = f.read()
        except Exception as e:
            log(f"read failed {file_id}: {e}")
            return None
        try:
            fd = FileData(file_id, abs_path, source)
        except SyntaxError as e:
            log(f"parse failed {file_id}: {e}")
            # Still register a minimal file node so it appears in the graph.
            fd = _StubFile(file_id, abs_path, source)
        self.files[file_id] = fd
        self.module_to_file[fd.module_name] = file_id
        return fd

    # ---- ops ----

    def op_open(self, msg):
        self.root = msg["root"]
        self.files.clear()
        self.module_to_file.clear()
        if jedi is not None:
            try:
                self.jedi_project = jedi.Project(self.root)
            except Exception as e:
                log(f"jedi project init failed: {e}")
                self.jedi_project = None
        # Bring up pyright (precision resolver) if the Node side handed us an
        # argv for its language server. Any failure → stay Jedi-only.
        argv = msg.get("pyright")
        if argv:
            try:
                self.pyright = PyrightClient(argv, self.root)
                log("pyright resolver active")
            except Exception as e:
                log(f"pyright init failed, falling back to jedi: {e}")
                self.pyright = None
        for abs_path in self.discover():
            self.parse_file(abs_path)
        files = [fd.file_node for fd in self.files.values()]
        asts = {fid: fd.ast_response() for fid, fd in self.files.items()}
        # Warm reopen: build edges only for the affected files (the Node side
        # splices cached edges for the rest). Every file is still parsed above,
        # so cross-file resolution into unchanged files works; what's skipped is
        # the expensive Jedi/pyright resolution for unaffected files. None =
        # cold open = resolve everything.
        affected = msg.get("affected")
        edge_from = set(self.files.keys()) if affected is None else set(affected)
        import_edges = self.build_import_edges(edge_from)
        semantic_edges = self.build_semantic_edges(edge_from)
        return {
            "files": files,
            "asts": asts,
            "importEdges": import_edges,
            "semanticEdges": semantic_edges,
        }

    def op_extract(self, msg):
        fd = self.files.get(msg["fileId"])
        return {"ast": fd.ast_response() if fd else None}

    def op_source(self, msg):
        fd = self.files.get(msg["fileId"])
        return {"source": fd.source if fd else None}

    def op_validate(self, msg):
        # Dry-run parse + node walk on a PROPOSED buffer. Constructs a LOCAL
        # FileData without assigning into self.files, so live state is untouched
        # (FileData only becomes shared when parse_file stores it). ok=False if
        # the buffer wouldn't parse / would break our walk.
        file_id = msg["fileId"]
        text = msg["text"]
        abs_path = os.path.join(self.root, file_id.replace("/", os.sep))
        diags = []
        try:
            FileData(file_id, abs_path, text)
        except SyntaxError as e:
            line = e.lineno or 1
            col = e.offset or 1
            diags.append({
                "severity": "error",
                "message": e.msg or "SyntaxError",
                "startLineNumber": line,
                "startColumn": col,
                "endLineNumber": line,
                "endColumn": col + 1,
            })
        except Exception as e:
            diags.append({
                "severity": "error",
                "message": str(e),
                "startLineNumber": 1,
                "startColumn": 1,
                "endLineNumber": 1,
                "endColumn": 2,
            })
        # NB: use "valid", NOT "ok" — the RPC main loop overwrites result["ok"]
        # with the transport-level success flag, which would clobber ours.
        return {"valid": not any(d["severity"] == "error" for d in diags), "diagnostics": diags}

    def op_apply_change(self, msg):
        kind = msg["kind"]
        file_id = msg["fileId"]
        if kind == "removed":
            fd = self.files.pop(file_id, None)
            if fd:
                self.module_to_file.pop(fd.module_name, None)
            return {"file": None, "ast": None}
        abs_path = os.path.join(self.root, file_id.replace("/", os.sep))
        if not os.path.exists(abs_path):
            return {"file": None, "ast": None}
        fd = self.parse_file(abs_path)
        if not fd:
            return {"file": None, "ast": None}
        return {"file": fd.file_node, "ast": fd.ast_response()}

    def op_build_edges(self, msg):
        from_ids = set(msg["fromFileIds"])
        return {
            "imports": self.build_import_edges(from_ids),
            "semanticEdges": self.build_semantic_edges(from_ids),
        }

    def op_importers_of(self, msg):
        file_id = msg["fileId"]
        out = []
        for fid, fd in self.files.items():
            if fid == file_id:
                continue
            if isinstance(fd, _StubFile):
                continue
            for imp in fd.imports:
                for target in self.resolve_import_targets(fd, imp):
                    if target == file_id:
                        out.append(fid)
                        break
                else:
                    continue
                break
        return {"importers": out}

    # ---- edge building ----

    def resolve_import_targets(self, fd, imp):
        targets = []
        if imp["level"] == 0 and "modules" in imp:
            # `import a.b.c` — resolve each dotted module.
            for mod in imp["modules"]:
                t = self.module_to_file.get(mod)
                if t:
                    targets.append(t)
        else:
            # `from [.]module import names`
            base = self.resolve_from_module(fd, imp)
            if base is not None:
                t = self.module_to_file.get(base)
                if t:
                    targets.append(t)
                # `from pkg import submod` — names may themselves be modules.
                for nm in imp.get("names", []):
                    sub = f"{base}.{nm}" if base else nm
                    t2 = self.module_to_file.get(sub)
                    if t2:
                        targets.append(t2)
        return targets

    def resolve_from_module(self, fd, imp):
        level = imp["level"]
        module = imp.get("module")
        if level == 0:
            return module
        # Relative import: walk up `level` packages from this file's package.
        pkg = fd.module_name
        # A module file's package is its parent; __init__'s package is itself.
        if not fd.file_id.endswith("/__init__.py") and "." in pkg:
            pkg = pkg.rsplit(".", 1)[0]
        elif not fd.file_id.endswith("/__init__.py"):
            pkg = ""
        parts = pkg.split(".") if pkg else []
        up = level - 1
        if up > 0:
            parts = parts[:-up] if up <= len(parts) else []
        base = ".".join(parts)
        if module:
            base = f"{base}.{module}" if base else module
        return base

    def build_import_edges(self, from_ids):
        edges = []
        for fid in from_ids:
            fd = self.files.get(fid)
            if not fd or isinstance(fd, _StubFile):
                continue
            for imp in fd.imports:
                for target in self.resolve_import_targets(fd, imp):
                    if target == fid:
                        continue
                    edges.append({
                        "id": f"{fid}->{target}@{imp['char']}",
                        "kind": "imports",
                        "fromId": fid,
                        "toId": target,
                        "fromAstNodeId": imp["astId"],
                    })
        return edges

    def build_semantic_edges(self, from_ids):
        # Need at least one resolver.
        if self.pyright is None and jedi is None:
            return []
        edges = []
        seen = set()

        def emit(kind, from_id, to_id, via):
            if from_id == to_id:
                return
            key = f"{from_id}~{kind}~{to_id}"
            if key in seen:
                return
            seen.add(key)
            rec = {"id": key, "kind": kind, "fromId": from_id, "toId": to_id}
            if via and via != to_id:
                rec["viaImportNodeId"] = via
            edges.append(rec)

        for fid in from_ids:
            fd = self.files.get(fid)
            if not fd or isinstance(fd, _StubFile):
                continue
            # Jedi script (used for the import-alias `via` routing and as the
            # per-query target fallback when pyright can't resolve).
            script = None
            if jedi is not None:
                try:
                    script = jedi.Script(
                        code=fd.source, path=fd.abs_path, project=self.jedi_project
                    )
                except Exception as e:
                    log(f"jedi script failed {fid}: {e}")
            # Open the document in pyright so definition queries bind it.
            opened = False
            if self.pyright is not None:
                try:
                    self.pyright.did_open(fd.abs_path, fd.source)
                    opened = True
                except Exception as e:
                    log(f"pyright did_open failed {fid}, disabling: {e}")
                    self.pyright = None
            try:
                for call in fd.call_sites:
                    target, via = self.resolve(fd, script, call["line"], call["col"])
                    if target:
                        emit("calls", call["astId"], target, via)
                for base in fd.class_bases:
                    target, via = self.resolve(fd, script, base["line"], base["col"])
                    if target:
                        emit("extends", base["astId"], target, via)
            finally:
                if opened and self.pyright is not None:
                    try:
                        self.pyright.did_close(fd.abs_path)
                    except Exception:
                        pass
        return edges

    def resolve(self, fd, script, line, col):
        """Return (targetAstId, viaImportNodeId) for a name at (line, col).

        Target resolution prefers pyright (a real type checker) and falls back
        to Jedi per-query; the `via` (local import-alias routing) stays on Jedi,
        which exposes the pre-import-follow binding directly."""
        target = None

        if self.pyright is not None:
            try:
                for path, l0, c0 in self.pyright.definition(fd.abs_path, line - 1, col):
                    tid = self.loc_to_id(path, l0, c0)
                    if tid:
                        target = tid
                        break
            except Exception as e:
                log(f"pyright definition failed, disabling: {e}")
                self.pyright = None

        if target is None and script is not None:
            try:
                for d in script.goto(line, col + 1, follow_imports=True):
                    tid = self.def_to_id(d)
                    if tid:
                        target = tid
                        break
            except Exception:
                pass

        if target is None:
            return None, None

        # Local binding (pre-import-follow): if it lands on an import alias in
        # THIS file, route the connector through it. Jedi only.
        via = None
        if script is not None:
            try:
                for d in script.goto(line, col + 1, follow_imports=False):
                    mp = getattr(d, "module_path", None)
                    if mp and self.path_to_file_id(str(mp)) == fd.file_id:
                        aid = fd.alias_index.get((d.line, d.name))
                        if aid:
                            via = aid
                            break
            except Exception:
                pass
        return target, via

    # Map a pyright/jedi definition LOCATION (file path + 0-based line/char of
    # the name) back to an emitted AST id, by reading the identifier at that
    # position and looking it up in the target file's def_index.
    def loc_to_id(self, abs_path, line0, char0):
        fid = self.path_to_file_id(abs_path)
        if fid is None:
            return None
        fd = self.files.get(fid)
        if not fd or isinstance(fd, _StubFile):
            return None
        lines = fd.source.splitlines()
        if line0 < 0 or line0 >= len(lines):
            return None
        seg = lines[line0][char0:]
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", seg)
        if not m:
            return None
        return fd.def_index.get((line0 + 1, m.group(0)))

    def def_to_id(self, d):
        mp = getattr(d, "module_path", None)
        if not mp:
            return None
        fid = self.path_to_file_id(str(mp))
        if fid is None:
            return None
        fd = self.files.get(fid)
        if not fd or isinstance(fd, _StubFile):
            return None
        if d.line is None:
            return None
        return fd.def_index.get((d.line, d.name))

    def path_to_file_id(self, abs_path):
        try:
            rel = os.path.relpath(abs_path, self.root).replace(os.sep, "/")
        except Exception:
            return None
        if rel.startswith(".."):
            return None
        return rel


class _StubFile:
    """Stand-in for a file that failed to parse — appears in the graph as a
    bare file node with an empty AST so the rest of the project still loads."""

    __slots__ = ("file_id", "abs_path", "source", "file_node", "module_name",
                 "imports", "call_sites", "class_bases", "def_index", "alias_index")

    def __init__(self, file_id, abs_path, source):
        self.file_id = file_id
        self.abs_path = abs_path
        self.source = source
        self.module_name = module_name_for(file_id)
        self.file_node = build_file_node(file_id, abs_path, source)
        self.imports = []
        self.call_sites = []
        self.class_bases = []
        self.def_index = {}
        self.alias_index = {}

    def ast_response(self):
        root_id = f"{self.file_id}#0"
        return {
            "fileId": self.file_id,
            "rootId": root_id,
            "nodes": [{
                "id": root_id, "parentId": None, "syntaxKind": "Module",
                "name": None, "start": 0, "end": len(self.source),
            }],
        }


def excluded_dir(name):
    return name in {
        "node_modules", "dist", "build", ".git", "venv", ".venv", "env",
        "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", ".eggs",
        "site-packages",
    } or name.startswith(".")


# --- main loop ------------------------------------------------------------


def main():
    analyzer = Analyzer()
    handlers = {
        "open": analyzer.op_open,
        "extract": analyzer.op_extract,
        "source": analyzer.op_source,
        "validate": analyzer.op_validate,
        "applyChange": analyzer.op_apply_change,
        "buildEdges": analyzer.op_build_edges,
        "importersOf": analyzer.op_importers_of,
    }
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            log(f"bad request json: {e}")
            continue
        mid = msg.get("id")
        op = msg.get("op")
        if op == "close":
            if analyzer.pyright is not None:
                analyzer.pyright.close()
            break
        handler = handlers.get(op)
        if handler is None:
            print(json.dumps({"id": mid, "ok": False, "error": f"unknown op {op}"}), flush=True)
            continue
        try:
            result = handler(msg)
            result["id"] = mid
            result["ok"] = True
            print(json.dumps(result), flush=True)
        except Exception as e:
            log("handler error:\n" + traceback.format_exc())
            print(json.dumps({"id": mid, "ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
