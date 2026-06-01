import {useRef, useState} from "react";
import type React from "react";
import {useConfigStore} from "../../graph/config/store";

// Save / load / delete named templates, plus JSON export & import. A template
// is the whole config; loading one replaces the live config (and the canvas
// updates next frame). Built-in presets are read-only.
export function TemplateManager() {
    const templates = useConfigStore((s) => s.templates);
    const activeId = useConfigStore((s) => s.activeTemplateId);
    const loadTemplate = useConfigStore((s) => s.loadTemplate);
    const deleteTemplate = useConfigStore((s) => s.deleteTemplate);
    const saveTemplate = useConfigStore((s) => s.saveTemplate);
    const exportTemplate = useConfigStore((s) => s.exportTemplate);
    const importTemplate = useConfigStore((s) => s.importTemplate);

    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);

    function onExport(id: string, label: string) {
        const json = exportTemplate(id);
        if (!json) return;
        const blob = new Blob([json], {type: "application/json"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${label.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}.codegraph.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = ""; // allow re-importing the same file
        if (!file) return;
        const text = await file.text();
        const res = importTemplate(text);
        setError(res.ok ? null : res.error ?? "Import failed");
    }

    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.5rem"}}>
            {/* Saved templates */}
            <div style={{display: "flex", flexDirection: "column", gap: "0.3rem"}}>
                {templates.map((t) => (
                    <div key={t.id} style={{...rowStyle, background: t.id === activeId ? "rgba(58,111,176,0.25)" : "rgba(28,28,33,0.7)"}}>
                        <button type="button" onClick={() => loadTemplate(t.id)} style={loadBtnStyle} title="Load this template">
                            {t.name}
                            {t.builtin ? <span style={{opacity: 0.5}}> · preset</span> : null}
                        </button>
                        <button type="button" onClick={() => onExport(t.id, t.name)} style={miniBtnStyle} title="Export to JSON file">
                            ⤓
                        </button>
                        <button
                            type="button"
                            onClick={() => deleteTemplate(t.id)}
                            disabled={t.builtin}
                            style={{...miniBtnStyle, opacity: t.builtin ? 0.3 : 0.85, cursor: t.builtin ? "default" : "pointer"}}
                            title={t.builtin ? "Presets can't be deleted" : "Delete"}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>

            {/* Save current config */}
            <div style={{display: "flex", gap: "0.4rem"}}>
                <input
                    value={name}
                    placeholder="Save current as…"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && name.trim()) {
                            saveTemplate(name);
                            setName("");
                        }
                    }}
                    style={{...inputStyle, flex: 1}}
                />
                <button
                    type="button"
                    onClick={() => {
                        if (name.trim()) {
                            saveTemplate(name);
                            setName("");
                        }
                    }}
                    style={actionBtnStyle}
                >
                    Save
                </button>
            </div>

            {/* Import */}
            <div style={{display: "flex", alignItems: "center", gap: "0.4rem"}}>
                <button type="button" onClick={() => fileRef.current?.click()} style={actionBtnStyle}>
                    Import JSON…
                </button>
                <input ref={fileRef} type="file" accept=".json,application/json" onChange={onImportFile} style={{display: "none"}} />
                {error ? <span style={{color: "#ff8b6b", fontSize: "0.68rem"}}>{error}</span> : null}
            </div>
        </div>
    );
}

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    borderRadius: 5,
    padding: "0.15rem 0.2rem 0.15rem 0.15rem",
    boxShadow: "inset 0 0 0 1px rgba(120,120,130,0.2)",
};

const loadBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
    background: "transparent",
    color: "#e6e6e6",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    textAlign: "left",
    flex: 1,
    cursor: "pointer",
    padding: "0.2rem 0.35rem",
};

const miniBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: "1px solid rgba(120,120,130,0.35)",
    borderRadius: 4,
    background: "rgba(40,40,46,0.85)",
    color: "#cfcfd6",
    fontFamily: "inherit",
    fontSize: "0.7rem",
    width: "1.4rem",
    height: "1.4rem",
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
    appearance: "none",
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: "#e6e6e6",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.25rem 0.4rem",
};

const actionBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 5,
    background: "rgba(40,40,46,0.85)",
    color: "#9aa3ff",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.25rem 0.6rem",
    cursor: "pointer",
};
