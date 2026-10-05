// TutorBot for VS Code — a Claude Code–style chat panel for the TutorBot (pi)
// tutor.
//
// The extension runs TutorBot itself: it starts `pi --mode rpc` in the TutorBot
// home folder and talks to it over stdin/stdout (JSON lines). The chat view
// streams replies, shows tool steps, and renders dialogs and quizzes as cards
// you answer in place. Rich interactions (quizzes, typed answers, questions)
// travel over a private pipe to TutorBot (file descriptor 3, JSON lines), which
// also carries exercise state for the status bar, squiggles and live tests.
// Nothing listens on a network port.
"use strict";
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── settings & paths ───────────────────────────────────────────────────────
const cfg = (k) => vscode.workspace.getConfiguration("tutorbot").get(k);
// The folder TutorBot keeps its notes and progress in (Tutor/, Exercises/).
function home() {
  const dir = cfg("home") || path.join(os.homedir(), "TutorBot");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// pi (the agent engine) and TutorBot's pi extensions ship inside the
// extension (runtime/, built by scripts/build-runtime.mjs).
let extensionRoot;
const runtimeDir = () => path.join(extensionRoot, "runtime");
const TUTOR_EXTENSIONS = ["ask-user-question.ts", "quiz.ts", "exercises/index.ts", "tutor/index.ts"];
const TUTOR_SKILLS = ["teach"];
const dataDir = () => path.join(home(), "Tutor", ".data");

let output;
function log(msg) {
  output?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── the user's PATH ────────────────────────────────────────────────────────
// VS Code's extension host doesn't load ~/.zshrc, so tools TutorBot runs for
// exercises and class materials (java, python3, pdftotext) may be missing
// from its PATH. Ask a login shell once; fall back to the host's PATH.
let shellPath;
function resolveShellPath() {
  if (shellPath !== undefined) return Promise.resolve(shellPath);
  if (process.platform === "win32") return Promise.resolve((shellPath = process.env.PATH || ""));
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    cp.execFile(shell, ["-ilc", 'printf "\n__TB__%s__TB__\n" "$PATH"'], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // [\s\S]: shell startup files can leave junk (even newlines) in PATH.
      const m = String(stdout || "").match(/__TB__([\s\S]*?)__TB__/);
      if (err && !m) log(`couldn't read PATH from ${shell}: ${err.message}`);
      shellPath = ((m && m[1]) || process.env.PATH || "")
        .split(path.delimiter)
        .filter((d) => d && !/\s{2,}|\n/.test(d) && path.isAbsolute(d) && fs.existsSync(d))
        .join(path.delimiter) || process.env.PATH || "";
      resolve(shellPath);
    });
  });
}

// How to run pi: the bundled copy on VS Code's own Node.js, unless settings
// point elsewhere. tutorbot.tutorPath loads TutorBot's extensions from a
// working copy (for development) instead of the bundled one.
function piCommand() {
  const nodePath = cfg("nodePath") || process.execPath;
  const piPath = cfg("piPath") || path.join(runtimeDir(), "pi", "dist", "bundle", "cli.js");
  const tutor = cfg("tutorPath") || path.join(runtimeDir(), "tutor");
  if (!fs.existsSync(piPath)) throw new Error(`TutorBot's engine is missing (${piPath}). Reinstall the extension.`);
  // -ne/-ns/-np: load only TutorBot, never the user's other pi extensions,
  // skills or prompts; --no-approve: ignore project-local .pi folders.
  const args = [piPath, "--mode", "rpc", "-ne", "-ns", "-np", "--no-approve"];
  for (const e of TUTOR_EXTENSIONS) args.push("-e", path.join(tutor, "extensions", e));
  for (const k of TUTOR_SKILLS) args.push("--skill", path.join(tutor, "skills", k));
  // VS Code's binary runs as plain Node.js with ELECTRON_RUN_AS_NODE.
  const env = nodePath === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  return { nodePath, args, env };
}

// ── API keys ───────────────────────────────────────────────────────────────
// Keys live in VS Code's SecretStorage (the OS keychain) and reach TutorBot
// only as environment variables of the process the panel starts.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
  { id: "google", label: "Google Gemini", env: "GEMINI_API_KEY", url: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys" },
  { id: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", label: "Mistral", env: "MISTRAL_API_KEY", url: "https://console.mistral.ai/api-keys" },
  { id: "groq", label: "Groq", env: "GROQ_API_KEY", url: "https://console.groq.com/keys" },
  { id: "xai", label: "xAI (Grok)", env: "XAI_API_KEY", url: "https://console.x.ai" },
];
const secretKey = (provider) => `tutorbot.apiKey.${provider}`;

let secrets;
async function storedKeyEnv() {
  const env = {};
  for (const p of PROVIDERS) {
    const key = await secrets.get(secretKey(p.id));
    if (key) env[p.env] = key;
  }
  return env;
}

async function connectedProviders() {
  const out = [];
  for (const p of PROVIDERS) if (await secrets.get(secretKey(p.id))) out.push(p);
  return out;
}

// ── the TutorBot process (pi in RPC mode) ──────────────────────────────────
class TutorProcess {
  constructor(onEvent, onExit) {
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.pending = new Map();
    this.seq = 0;
    this.buf = "";
    this.child = undefined;
    this.stderr = "";
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  async start() {
    const PATH = await resolveShellPath();
    const { nodePath, args, env } = piCommand();
    // Empty = automatic: TutorBot picks a model from the connected providers.
    const model = String(cfg("model") || "").trim();
    const [provider, ...rest] = model.split("/");
    if (provider && rest.length) args.push("--provider", provider, "--model", rest.join("/"));
    else if (model) args.push("--model", model);
    const cwd = home();
    log(`starting TutorBot: ${nodePath} ${args.join(" ")}  (cwd ${cwd})`);
    const keys = await storedKeyEnv();
    if (Object.keys(keys).length) log(`API keys from VS Code: ${Object.keys(keys).join(", ")}`);
    this.child = cp.spawn(nodePath, args, {
      cwd,
      env: { ...process.env, ...env, ...keys, PATH, TUTORBOT: "1", TUTORBOT_PANEL: "1", TUTORBOT_PANEL_FD: "3", TERM_PROGRAM: "vscode" },
      // fd 3: the bridge pipe (see BridgeClient).
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    this.child.on("exit", (code, signal) => {
      log(`TutorBot exited (${code ?? signal})${this.stderr.trim() ? `\n${this.stderr.trim().slice(-1500)}` : ""}`);
      for (const p of this.pending.values()) p.reject(new Error("TutorBot stopped"));
      this.pending.clear();
      this.onExit(code, this.stderr);
    });
    return this.child.stdio[3];
  }

  // JSONL: split on \n only (U+2028/2029 are legal inside JSON strings).
  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not protocol output
      }
      if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.success === false ? p.reject(new Error(msg.error || `${msg.command} failed`)) : p.resolve(msg.data);
        continue;
      }
      this.onEvent(msg);
    }
  }

  send(cmd) {
    if (!this.running) return;
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  request(cmd) {
    if (!this.running) return Promise.reject(new Error("TutorBot isn't running"));
    const id = `vs-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ ...cmd, id });
    });
  }

  stop() {
    if (this.running) this.child.kill();
  }
}

// ── bridge client (quizzes, exercises, session resets) ─────────────────────
// JSON lines over the TutorBot process's fd 3. TutorBot sends {ev, data}
// events and {re, result} replies; we send {id, api, body} requests.
class BridgeClient {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.pipe = undefined;
    this.buf = "";
    this.seq = 0;
    this.pending = new Map();
  }

  get connected() {
    return Boolean(this.pipe && !this.pipe.destroyed);
  }

  attach(pipe) {
    this.close();
    this.pipe = pipe;
    this.buf = "";
    pipe.setEncoding("utf8");
    pipe.on("data", (chunk) => this.onData(chunk));
    pipe.on("error", (e) => log(`bridge error: ${e.message}`));
    pipe.on("close", () => {
      if (this.pipe === pipe) this.close();
    });
    this.onEvent("connected", {});
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`bad bridge message: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.re !== undefined) {
        const p = this.pending.get(msg.re);
        this.pending.delete(msg.re);
        if (p) p.resolve(msg.result || {});
      } else if (msg.ev) {
        try {
          this.onEvent(msg.ev, msg.data || {});
        } catch (e) {
          log(`bridge event ${msg.ev} failed: ${e.message}`);
        }
      }
    }
  }

  post(api, body) {
    if (!this.connected) return Promise.reject(new Error("TutorBot isn't connected yet"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.pipe.write(`${JSON.stringify({ id, api, body: body || {} })}\n`);
    });
  }

  close() {
    for (const p of this.pending.values()) p.reject(new Error("TutorBot stopped"));
    this.pending.clear();
    this.pipe = undefined;
  }
}

// ── controller: process ⇄ chat view ⇄ editor features ──────────────────────
class Controller {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.webviewReady = false;
    this.outbox = [];
    this.exercise = null;
    this.subject = null;
    this.statuses = {};
    this.widgets = {};
    this.running = false;
    this.commands = [];
    // Questions / dialogs still waiting for the learner. Re-sent after every
    // transcript reload so a reload never strands a blocked tool call.
    this.pendingAsks = new Map();
    this.pendingDialogs = new Map();
    this.liveTimer = undefined;
    this.proc = undefined;
    this.bridge = new BridgeClient((e, d) => this.onBridge(e, d));

    this.diagnostics = vscode.languages.createDiagnosticCollection("tutorbot");
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusItem.command = "tutorbot.focus";
    this.renderStatusBar();
    this.statusItem.show();
    context.subscriptions.push(this.diagnostics, this.statusItem);
  }

  // ---- view plumbing
  attach(view) {
    this.view = view;
    this.webviewReady = false;
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage((m) => this.onWebview(m));
  }

  post(msg) {
    if (this.view && this.webviewReady) this.view.webview.postMessage(msg);
    // Not visible: stream events are dropped (the transcript is reloaded from
    // pi when the view comes back), so this backlog stays small.
    else if (msg.type !== "rpc") this.outbox.push(msg);
  }

  flush() {
    const msgs = this.outbox;
    this.outbox = [];
    for (const m of msgs) this.view.webview.postMessage(m);
  }

  // ---- lifecycle
  async ensureStarted() {
    if (this.proc && this.proc.running) return;
    this.post({ type: "connection", state: "starting" });
    const proc = new TutorProcess(
      (ev) => this.onRpc(ev),
      (code, stderr) => {
        // A process we already replaced (restart) must not tear down the new one.
        if (this.proc !== proc) return;
        this.running = false;
        this.bridge.close();
        this.pendingAsks.clear();
        this.pendingDialogs.clear();
        this.post({ type: "connection", state: "stopped", detail: stderr.trim().split("\n").slice(-6).join("\n") });
        this.renderStatusBar();
      },
    );
    this.proc = proc;
    try {
      this.bridge.attach(await this.proc.start());
      this.refreshCommands();
    } catch (e) {
      this.post({ type: "connection", state: "stopped", detail: e.message });
      vscode.window.showErrorMessage(`TutorBot couldn't start: ${e.message}`);
    }
  }

  async restart() {
    const old = this.proc;
    this.proc = undefined;
    this.model = undefined;
    this.needsKey = false;
    if (old) old.stop();
    this.pendingAsks.clear();
    this.pendingDialogs.clear();
    this.post({ type: "clear" });
    setTimeout(() => this.ensureStarted(), 300);
  }

  async refreshCommands() {
    try {
      const data = await this.proc.request({ type: "get_commands" });
      const rank = { extension: 0, prompt: 1, skill: 2 };
      this.commands = (data.commands || [])
        .map((c) => ({ name: c.name, description: c.description || "", source: c.source }))
        .sort((a, b) => (rank[a.source] ?? 3) - (rank[b.source] ?? 3) || a.name.localeCompare(b.name));
      this.post({ type: "commands", commands: this.commands });
      // RPC answered, so TutorBot is up even if the bridge is slow to connect.
      this.post({ type: "connection", state: "running" });
      this.checkModel();
    } catch {
      // not ready yet; retried on the next history load
    }
  }

  // Which model is TutorBot actually using? None → it needs an API key.
  async checkModel() {
    try {
      const [avail, state] = await Promise.all([this.proc.request({ type: "get_available_models" }), this.proc.request({ type: "get_state" })]);
      const m = state && state.model;
      this.model = m && m.provider && m.provider !== "unknown" ? `${m.provider}/${m.id}` : "";
      this.needsKey = !((avail && avail.models) || []).length;
      this.post({ type: "model", model: this.model || (this.needsKey ? "no model" : "") });
      if (this.needsKey) this.promptForKey();
    } catch (e) {
      log(`model check failed: ${e.message}`);
    }
  }

  promptForKey() {
    this.post({ type: "needsKey" });
    if (this.keyPrompted) return;
    this.keyPrompted = true;
    vscode.window.showWarningMessage("TutorBot needs an AI provider. Connect an API key to start.", "Connect API Key").then((pick) => {
      if (pick) this.connectApiKey();
    });
  }

  async connectApiKey() {
    const connected = new Set((await connectedProviders()).map((p) => p.id));
    const pick = await vscode.window.showQuickPick(
      PROVIDERS.map((p) => ({ label: p.label, description: connected.has(p.id) ? "connected · replace key" : p.env, provider: p })),
      { title: "Connect an API key to TutorBot", placeHolder: "Which AI provider is your key from?" },
    );
    if (!pick) return;
    const p = pick.provider;
    const key = await vscode.window.showInputBox({
      title: `${p.label} API key`,
      prompt: `Paste your ${p.label} API key. It's stored in your system keychain and only passed to TutorBot. Get one at ${p.url}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? "Paste a key" : /\s/.test(v.trim()) ? "A key has no spaces" : undefined),
    });
    if (!key) return;
    await secrets.store(secretKey(p.id), key.trim());
    this.keyPrompted = false;
    log(`API key saved for ${p.id}`);
    // A model pinned to a provider without a key would keep failing: go automatic.
    const pinned = String(cfg("model") || "").split("/")[0];
    if (pinned && pinned !== p.id && !connected.has(pinned) && this.needsKey) {
      await vscode.workspace.getConfiguration("tutorbot").update("model", "", vscode.ConfigurationTarget.Global);
    }
    await this.restart();
    const ok = await waitFor(() => this.model !== undefined && this.proc && this.proc.running && !this.needsKey, 20000);
    vscode.window
      .showInformationMessage(ok ? `${p.label} connected. TutorBot is using ${this.model || "an automatic model"}.` : `${p.label} key saved, but TutorBot still has no model. Check the key, or pick a model.`, "Change Model")
      .then((c) => c && this.chooseModel());
  }

  async removeApiKey() {
    const connected = await connectedProviders();
    if (!connected.length) return vscode.window.showInformationMessage("No API keys are saved in TutorBot.");
    const pick = await vscode.window.showQuickPick(
      connected.map((p) => ({ label: p.label, description: p.env, provider: p })),
      { title: "Remove a TutorBot API key", placeHolder: "Which key should TutorBot forget?" },
    );
    if (!pick) return;
    await secrets.delete(secretKey(pick.provider.id));
    log(`API key removed for ${pick.provider.id}`);
    vscode.window.showInformationMessage(`${pick.provider.label} key removed.`);
    this.restart();
  }

  async loadHistory() {
    if (!this.proc || !this.proc.running) return;
    try {
      const [msgs, state] = await Promise.all([this.proc.request({ type: "get_messages" }), this.proc.request({ type: "get_state" })]);
      this.post({ type: "history", messages: msgs.messages || [], state });
      for (const req of this.pendingDialogs.values()) this.post({ type: "dialog", request: req });
      for (const ask of this.pendingAsks.values()) this.post({ type: "ask", ask });
      if (this.needsKey) this.post({ type: "needsKey" });
      if (!this.commands.length) this.refreshCommands();
    } catch (e) {
      log(`history failed: ${e.message}`);
    }
  }

  // ---- events from pi (RPC)
  onRpc(ev) {
    switch (ev.type) {
      case "agent_start":
        this.running = true;
        break;
      case "agent_settled":
        this.running = false;
        this.pendingAsks.clear();
        break;
      case "extension_ui_request":
        return this.onUiRequest(ev);
      case "response":
        if (ev.success === false) this.post({ type: "notice", level: "error", text: ev.error || `${ev.command} failed` });
        return;
      default:
        break;
    }
    this.post({ type: "rpc", event: ev });
  }

  onUiRequest(req) {
    switch (req.method) {
      case "notify":
        return this.post({ type: "notice", level: req.notifyType || "info", text: req.message });
      case "setStatus":
        if (req.statusText) this.statuses[req.statusKey] = req.statusText;
        else delete this.statuses[req.statusKey];
        return this.post({ type: "statuses", statuses: this.statuses });
      case "setWidget":
        if (req.widgetLines && req.widgetLines.length) this.widgets[req.widgetKey] = req.widgetLines;
        else delete this.widgets[req.widgetKey];
        return this.post({ type: "widgets", widgets: this.widgets });
      case "setTitle":
      case "set_editor_text":
        if (req.method === "set_editor_text") this.post({ type: "setInput", text: req.text || "" });
        return;
      default:
        // select / confirm / input / editor → an inline card in the chat
        this.pendingDialogs.set(req.id, req);
        if (req.timeout) setTimeout(() => this.pendingDialogs.delete(req.id), req.timeout);
        return this.post({ type: "dialog", request: req });
    }
  }

  // ---- events from the bridge
  onBridge(event, data) {
    if (event === "connected") return this.post({ type: "connection", state: "running" });
    if (event === "reset") {
      // A session started (startup, /home switch, new chat): reload the transcript.
      const st = data.state || {};
      this.resets = (this.resets || 0) + 1;
      this.setExercise(st.exercise ?? null);
      this.subject = st.subject ?? null;
      if (this.dashboard) this.dashboard.schedule();
      this.folders = st.folders || [];
      this.post({ type: "subject", subject: this.subject });
      this.post({ type: "folders", folders: this.folders });
      return this.loadHistory();
    }
    if (event === "state") {
      if (data.key === "exercise") this.setExercise(data.value ?? null);
      if (data.key === "subject") {
        this.subject = data.value ?? null;
        if (this.dashboard) this.dashboard.schedule();
        this.post({ type: "subject", subject: this.subject });
      }
      if (data.key === "folders") {
        this.folders = data.value || [];
        this.post({ type: "folders", folders: this.folders });
      }
      return;
    }
    if (event === "ask" && data.kind === "pickFolder") return this.answerPickFolder(data);
    if (event === "ask") {
      this.pendingAsks.set(data.id, data);
      return this.post({ type: "ask", ask: data });
    }
    if (event === "askDone") {
      this.pendingAsks.delete(data.id);
      return this.post({ type: "askDone", id: data.id });
    }
    if (event === "open" && data.file) return this.openFile(data.file);
    if (event === "diagnostics") return this.setDiagnostics(data.file, data.diagnostics || []);
  }

  // ---- messages from the chat view
  async onWebview(m) {
    switch (m.type) {
      case "ready":
        this.webviewReady = true;
        this.post({ type: "theme", kind: vscode.window.activeColorTheme.kind });
        this.post({ type: "model", model: this.model || String(cfg("model") || "") });
        this.flush();
        if (this.proc && this.proc.running) {
          this.post({ type: "connection", state: "running" });
          this.post({ type: "folders", folders: this.folders || [] });
          this.post({ type: "statuses", statuses: this.statuses });
          this.post({ type: "widgets", widgets: this.widgets });
          this.post({ type: "subject", subject: this.subject });
          this.post({ type: "exercise", exercise: this.exercise });
          if (this.commands.length) this.post({ type: "commands", commands: this.commands });
          this.loadHistory();
        } else this.ensureStarted();
        return;
      case "send": {
        const text = String(m.text || "").trim();
        if (!text) return;
        await this.ensureStarted();
        const cmd = { type: "prompt", message: text };
        // Extension commands run immediately even mid-turn; everything else
        // (plain messages, skills, prompt templates) is queued as a steer.
        const name = text.startsWith("/") ? text.slice(1).split(/\s/)[0] : "";
        const isExtCmd = name && this.commands.some((c) => c.name === name && c.source === "extension");
        if (this.running && !isExtCmd) cmd.streamingBehavior = "steer";
        try {
          await this.proc.request(cmd);
        } catch (e) {
          this.post({ type: "notice", level: "error", text: e.message });
        }
        return;
      }
      case "abort": {
        // Like Claude Code: pull queued messages back into the composer first,
        // otherwise pi would run them right after the interrupt.
        if (!this.proc || !this.proc.running) return;
        try {
          const q = await this.proc.request({ type: "clear_queue" });
          const restored = [...((q && q.steering) || []), ...((q && q.followUp) || [])];
          if (restored.length) this.post({ type: "restoreInput", text: restored.join("\n\n") });
        } catch {
          // older pi: nothing to restore
        }
        return this.proc.send({ type: "abort" });
      }
      case "uiResponse":
        this.pendingDialogs.delete(m.response && m.response.id);
        return this.proc && this.proc.send({ type: "extension_ui_response", ...m.response });
      case "answer":
        try {
          // Exercise card: grade what's in the editor, including unsaved typing.
          if (m.value && m.value.action === "check") await this.saveExerciseDoc();
          await this.bridge.post("answer", { id: m.id, value: m.value, cancelled: m.cancelled });
        } catch (e) {
          this.post({ type: "notice", level: "error", text: `Couldn't send your answer: ${e.message}` });
        }
        return;
      case "newChat":
        return this.newChat();
      case "home":
        return this.onWebview({ type: "send", text: "/home" });
      case "dashboard":
        return vscode.commands.executeCommand("tutorbot.dashboard");
      case "restart":
        return this.restart();
      case "exercise":
        if (m.action === "open" && this.exercise) return this.openFile(this.exercise.file);
        if (m.action === "submit") return this.submit();
        if (m.action === "hint") return this.hint();
        return;
      case "openLink":
        // Only web/mail links: a model-written vscode:// or command: link must not run anything.
        if (m.href && /^(https?:|mailto:)/i.test(m.href)) vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;
      case "chooseModel":
        return this.chooseModel();
      case "connectKey":
        return this.connectApiKey();
      case "sessions":
        return this.listSessions();
      case "renameSession":
        return this.rename("renameSession", { path: m.path, name: m.name });
      case "renameSubject":
        return this.rename("renameSubject", { from: m.from, to: m.to });
      case "openSession":
        return this.openSession(m.path);
      case "deleteSession":
        return this.deleteSession(m.path);
      case "showLog":
        return output.show(true);
      case "pickFolder":
        return this.pickFolderForSubject();
      case "lessonFeedback":
        try {
          await this.bridge.post("lessonFeedback", { concepts: m.concepts || [], rating: m.rating });
        } catch (e) {
          this.post({ type: "notice", level: "error", text: `Couldn't save your rating: ${e.message}` });
        }
        return;
      default:
        return;
    }
  }

  async newChat() {
    await this.ensureStarted();
    try {
      await this.proc.request({ type: "new_session" });
    } catch (e) {
      this.post({ type: "notice", level: "error", text: e.message });
    }
  }

  // ---- conversations & subjects (served by TutorBot over the bridge)
  async listSessions() {
    try {
      const data = await this.bridge.post("sessions", {});
      if (data.error) throw new Error(data.error);
      this.sessions = data.sessions || [];
      this.post({ type: "sessions", data });
    } catch (e) {
      this.post({ type: "sessions", error: e.message });
    }
  }

  async rename(api, body) {
    try {
      const r = await this.bridge.post(api, body);
      if (r.ok === false || r.error) this.post({ type: "renameError", error: r.error || "Rename failed" });
    } catch (e) {
      this.post({ type: "renameError", error: e.message });
    }
    return this.listSessions();
  }

  // Delete a conversation: confirm, then move its file to the Trash. Only
  // files TutorBot itself listed can be deleted. Learning progress is kept.
  async deleteSession(file) {
    const c = (this.sessions || []).find((x) => x.path === file);
    if (!c) return this.listSessions();
    if (c.current && this.running) {
      this.post({ type: "renameError", error: "TutorBot is replying in that conversation. Stop it first, then delete." });
      return this.listSessions();
    }
    const pick = await vscode.window.showWarningMessage(
      `Delete "${c.title}"?`,
      { modal: true, detail: "The conversation moves to the Trash. Your progress, grades and review schedule are kept." },
      "Delete",
    );
    if (pick !== "Delete") return;
    try {
      // Leave the conversation first so TutorBot doesn't write to it again.
      if (c.current) await this.proc.request({ type: "new_session" });
      if (fs.existsSync(file)) await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
      log(`deleted conversation ${file}`);
    } catch (e) {
      this.post({ type: "renameError", error: `Couldn't delete that conversation: ${e.message}` });
    }
    return this.listSessions();
  }

  async openSession(file) {
    if (!file || !this.proc || !this.proc.running) return;
    try {
      await this.proc.request({ type: "switch_session", sessionPath: file });
      await this.loadHistory();
    } catch (e) {
      this.post({ type: "notice", level: "error", text: `Couldn't open that conversation: ${e.message}` });
    }
  }

  async chooseModel() {
    await this.ensureStarted();
    let models = [];
    try {
      models = ((await this.proc.request({ type: "get_available_models" })) || {}).models || [];
    } catch (e) {
      log(`model list failed: ${e.message}`);
    }
    const current = String(cfg("model") || "");
    const CONNECT = "$(key) Connect an API key…";
    const items = [
      { label: "Automatic", description: current ? "" : `current${this.model ? ` · ${this.model}` : ""}`, value: "" },
      ...models.map((m) => {
        const id = `${m.provider}/${m.id}`;
        return { label: id, description: id === current ? "current" : m.name && m.name !== m.id ? m.name : "", value: id };
      }),
      { label: CONNECT, alwaysShow: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "TutorBot model",
      placeHolder: models.length ? "Pick a model from your connected providers" : "No providers connected yet: connect an API key first",
      matchOnDescription: true,
    });
    if (!pick) return;
    if (pick.label === CONNECT) return this.connectApiKey();
    if (pick.value === current) return;
    await vscode.workspace.getConfiguration("tutorbot").update("model", pick.value, vscode.ConfigurationTarget.Global);
    if (!pick.value) return this.restart();
    const [provider, ...rest] = pick.value.split("/");
    try {
      await this.proc.request({ type: "set_model", provider, modelId: rest.join("/") });
      this.model = pick.value;
      this.post({ type: "model", model: pick.value });
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn't switch model: ${e.message}`);
    }
  }

  // ---- exercises (status bar, squiggles, live tests)
  setExercise(ex) {
    const prevFile = this.exercise && this.exercise.file;
    this.exercise = ex;
    vscode.commands.executeCommand("setContext", "tutorbot.hasExercise", Boolean(ex));
    this.updateExerciseContext();
    if (!ex && prevFile) this.diagnostics.delete(vscode.Uri.file(prevFile));
    this.post({ type: "exercise", exercise: ex });
    this.renderStatusBar();
  }

  // ---- class folders (native VS Code folder picker)
  async showFolderDialog(title) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Use this folder",
      title: title || "Choose the folder with your class materials",
    });
    return picked && picked[0] ? picked[0].fsPath : undefined;
  }

  // pi asked for a folder (home picker / /folder): answer it with VS Code's dialog.
  async answerPickFolder(ask) {
    const path = await this.showFolderDialog(ask.title);
    try {
      await this.bridge.post("answer", path ? { id: ask.id, value: { path } } : { id: ask.id, cancelled: true });
    } catch (e) {
      log(`folder answer failed: ${e.message}`);
    }
  }

  // The folder chip in the composer.
  async pickFolderForSubject() {
    if (!this.subject) {
      this.post({ type: "notice", level: "warning", text: "Pick a subject first (Home), then choose its class folder." });
      return;
    }
    const path = await this.showFolderDialog(`Choose the folder with your ${this.subject} class materials`);
    if (!path) return;
    try {
      const r = await this.bridge.post("setFolder", { path });
      if (r && r.ok) this.post({ type: "notice", level: "info", text: `${this.subject} now uses **${path.split("/").pop()}**. Indexing it in the background; TutorBot will learn your teacher's question style from it.` });
      else this.post({ type: "notice", level: "error", text: (r && r.error) || "Couldn't add that folder." });
    } catch (e) {
      this.post({ type: "notice", level: "error", text: e.message });
    }
  }

  // ---- study nudges: due reviews and close exams, read straight from the
  // progress file so they work even before TutorBot is started.
  studyState() {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir(), "progress.json"), "utf8"));
      const now = Date.now();
      const due = Object.values(data.concepts || {}).filter((c) => c.attempts > 0 && c.due && Date.parse(c.due) <= now);
      const bySubject = {};
      for (const c of due) bySubject[c.subject] = (bySubject[c.subject] || 0) + 1;
      const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
      const exams = (data.assessments || [])
        .filter((a) => !a.done)
        .map((a) => ({ ...a, days: Math.round((Date.parse(a.date) - today) / 86400000) }))
        .filter((a) => a.days >= 0 && a.days <= 7)
        .sort((a, b) => a.days - b.days);
      return { due: due.length, bySubject, exams };
    } catch {
      return { due: 0, bySubject: {}, exams: [] };
    }
  }

  checkNudge(context) {
    this.study = this.studyState();
    this.renderStatusBar();
    const today = new Date().toISOString().slice(0, 10);
    if (context.globalState.get("tutorbot.lastNudge") === today) return;
    const { due, bySubject, exams } = this.study;
    const exam = exams[0];
    if (!due && !(exam && exam.days <= 3)) return;
    context.globalState.update("tutorbot.lastNudge", today);
    const parts = [];
    if (exam) parts.push(`${exam.subject} ${exam.name} ${exam.days === 0 ? "is today" : exam.days === 1 ? "is tomorrow" : `in ${exam.days} days`}`);
    if (due) parts.push(`${due} review${due === 1 ? "" : "s"} due (${Object.entries(bySubject).map(([k, v]) => `${k} ${v}`).join(", ")})`);
    vscode.window.showInformationMessage(`TutorBot: ${parts.join(" · ")}`, "Review now", "Later").then(async (pick) => {
      if (pick !== "Review now") return;
      this.reveal();
      await this.ensureStarted();
      setTimeout(() => this.onWebview({ type: "send", text: exam && exam.days <= 3 ? "/checkpoint" : "/review" }), 1500);
    });
  }

  renderStatusBar() {
    const ex = this.exercise;
    if (!ex) {
      const due = this.study && this.study.due ? ` · ${this.study.due} due` : "";
      this.statusItem.text = this.proc && this.proc.running ? `$(mortar-board) TutorBot${this.subject ? ` · ${this.subject}` : ""}${due}` : `$(mortar-board) TutorBot${due}`;
      this.statusItem.tooltip = this.study && this.study.due ? `${this.study.due} review(s) due. Open the TutorBot chat (⌘Esc) · progress: TutorBot: Open Progress` : "Open the TutorBot chat (⌘Esc) · progress: TutorBot: Open Progress";
      this.statusItem.command = "tutorbot.focus";
      return;
    }
    const s = ex.status;
    let label = "not run yet";
    let icon = "$(beaker)";
    if (s && s.running) {
      label = "testing…";
      icon = "$(sync~spin)";
    } else if (s && s.compileError) {
      label = "doesn't compile";
      icon = "$(error)";
    } else if (s) {
      label = `${s.passed}/${s.total} tests`;
      icon = s.passed === s.total ? "$(pass-filled)" : "$(beaker)";
    }
    this.statusItem.text = `${icon} ${ex.title}: ${label}`;
    this.statusItem.tooltip = new vscode.MarkdownString(
      `**TutorBot exercise — ${ex.title}**\n\n` +
        (s && s.results ? s.results.map((r) => `${r.pass ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`).join("\n\n") : "") +
        "\n\nClick to submit · ⌘⌥H for a hint",
    );
    this.statusItem.command = "tutorbot.submit";
  }

  updateExerciseContext() {
    const ed = vscode.window.activeTextEditor;
    const isEx = Boolean(this.exercise && ed && samePath(ed.document.uri.fsPath, this.exercise.file));
    vscode.commands.executeCommand("setContext", "tutorbot.isExerciseFile", isEx);
  }

  setDiagnostics(file, list) {
    const uri = vscode.Uri.file(file);
    const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, file));
    this.diagnostics.set(
      uri,
      list.map((d) => {
        const line = Math.max(0, d.line - 1);
        const range = doc && line < doc.lineCount ? doc.lineAt(line).range : new vscode.Range(line, 0, line, 200);
        const diag = new vscode.Diagnostic(range, d.message, d.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        diag.source = "TutorBot";
        return diag;
      }),
    );
  }

  async openFile(file) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  async saveExerciseDoc() {
    if (!this.exercise) return;
    const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, this.exercise.file));
    if (doc && doc.isDirty) await doc.save();
  }

  async submit() {
    if (!this.exercise) return vscode.window.showInformationMessage("No TutorBot exercise is active.");
    await this.saveExerciseDoc();
    this.reveal();
    this.bridge.post("submit", {}).catch((e) => vscode.window.showErrorMessage(e.message));
  }

  async hint() {
    if (!this.exercise) return vscode.window.showInformationMessage("No TutorBot exercise is active.");
    await this.saveExerciseDoc();
    const question = await vscode.window.showInputBox({ title: "Ask TutorBot for a hint", prompt: "Optional: what are you stuck on? (Enter for the next hint)" });
    if (question === undefined) return;
    this.reveal();
    this.bridge.post("hint", { question: question.trim() || undefined }).catch((e) => vscode.window.showErrorMessage(e.message));
  }

  async askAboutSelection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sel = ed.selection;
    const code = ed.document.getText(sel.isEmpty ? undefined : sel);
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const lines = sel.isEmpty ? "" : ` (lines ${sel.start.line + 1}–${sel.end.line + 1})`;
    // Prefill the chat input with the code so the learner can add their question.
    this.reveal();
    this.post({ type: "insertContext", text: `In \`${rel}\`${lines}:\n\`\`\`${ed.document.languageId}\n${code.trimEnd()}\n\`\`\`\n` });
  }

  onType(e) {
    const ex = this.exercise;
    if (!ex || !this.bridge.connected || !samePath(e.document.uri.fsPath, ex.file)) return;
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.bridge.post("buffer", { file: ex.file, content: e.document.getText() }).catch((err) => log(`live check failed: ${err.message}`));
    }, cfg("liveCheckDelayMs") || 800);
  }

  reveal() {
    vscode.commands.executeCommand("tutorbot.chat.focus");
  }

  dispose() {
    this.bridge.close();
    if (this.proc) this.proc.stop();
  }
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// ── progress dashboard (editor tab) ────────────────────────────────────────
// Reads TutorBot's files directly, so it works whether or not TutorBot is
// running, and re-renders when they change.
const coursesDir = () => path.join(home(), "Tutor", "Courses");
const topicMapFile = (subject) => path.join(coursesDir(), `${String(subject).replace(/[/\\:]/g, "-").trim()} - Topics.json`);

// Missing file → fallback. A file that exists but won't parse (corrupt, or an
// iCloud conflict mid-sync) throws when `strict`, so it isn't shown as "empty".
function readJson(file, fallback, strict) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (strict) throw new Error(`${path.basename(file)} couldn't be read (${e.message}). TutorBot may be mid-write; it will retry.`);
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class DashboardPanel {
  constructor(context, controller) {
    this.context = context;
    this.controller = controller;
    this.panel = undefined;
    this.watchers = [];
    this.timer = undefined;
    this.selected = undefined;
  }

  open() {
    if (this.panel) return this.panel.reveal(vscode.ViewColumn.One);
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("tutorbot.dashboard", "TutorBot Progress", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = vscode.Uri.joinPath(media, "icon.svg");
    const uri = (p) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, p)).toString();
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const csp = [
      "default-src 'none'",
      `img-src ${panel.webview.cspSource} data:`,
      `font-src ${panel.webview.cspSource}`,
      `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("vendor/katex.min.css")}">
<link rel="stylesheet" href="${uri("dashboard.css")}">
<title>TutorBot Progress</title></head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri("vendor/katex.min.js")}"></script>
<script nonce="${nonce}" src="${uri("dashboard.js")}"></script>
</body></html>`;
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.unwatch();
    });
    this.panel = panel;
    this.watch();
  }

  watch() {
    this.unwatch();
    for (const dir of [dataDir(), coursesDir()]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, (_e, file) => {
          // Temp files churn constantly; only data matters.
          if (file && !/\.json$/.test(String(file))) return;
          this.schedule();
        });
        // The folder can vanish and come back (iCloud): watch it again.
        w.on("error", () => {
          if (!this.panel) return;
          clearTimeout(this.rewatch);
          this.rewatch = setTimeout(() => this.panel && (this.watch(), this.schedule()), 2000);
        });
        this.watchers.push(w);
      } catch (e) {
        log(`dashboard watch failed for ${dir}: ${e.message}`);
      }
    }
  }

  unwatch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
    clearTimeout(this.rewatch);
    clearTimeout(this.retry);
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 400);
  }

  data() {
    const { build } = require("./lib/dashboard-data.js");
    const progress = readJson(path.join(dataDir(), "progress.json"), { concepts: {}, quizLog: [] }, true);
    const registry = readJson(path.join(dataDir(), "subjects.json"), { subjects: {} });
    const subjects = Object.values(registry.subjects || {}).filter((s) => s && s.name);
    const names = new Set([...subjects.map((s) => s.name), ...Object.values(progress.concepts || {}).map((c) => c.subject)]);
    const maps = {};
    for (const n of names) {
      const m = readJson(topicMapFile(n), null);
      if (m) maps[n] = m;
    }
    const links = readJson(path.join(dataDir(), "topic-links.json"), {});
    const built = build({ progress, subjects, maps, links, now: new Date() });
    for (const s of built.subjects) {
      const reg = subjects.find((x) => x.name === s.name);
      s.hasFolder = Boolean(reg && reg.folders && reg.folders.length);
    }
    return built;
  }

  refresh() {
    if (!this.panel) return;
    try {
      this.panel.webview.postMessage({ type: "data", data: this.data(), active: this.controller.subject || null, selected: this.selected });
    } catch (e) {
      log(`dashboard build failed: ${e.message}`);
      this.panel.webview.postMessage({ type: "error", text: e.message });
      // A half-written file: try again shortly.
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.refresh(), 3000);
    }
  }

  async onMessage(m) {
    try {
      await this.handle(m);
    } catch (e) {
      log(`dashboard: ${m && m.type} failed: ${e.message}`);
      if (this.panel) this.panel.webview.postMessage({ type: "error", text: `Couldn't save that: ${e.message}` });
      this.refresh();
    }
  }

  async handle(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ready":
        this.panel.webview.postMessage({ type: "theme", kind: vscode.window.activeColorTheme.kind });
        return this.refresh();
      case "select":
        this.selected = String(m.subject || "");
        return;
      case "action":
        return this.runAction(m);
      case "confirmTopic": {
        // Only real concepts, and only topics on that subject's course map.
        const progress = readJson(path.join(dataDir(), "progress.json"), { concepts: {} }, true);
        const concept = progress.concepts && progress.concepts[m.conceptId];
        if (!concept) throw new Error("that concept no longer exists");
        // The dashboard shows maps under the registry's spelling of the subject.
        const reg = readJson(path.join(dataDir(), "subjects.json"), { subjects: {} });
        const slugOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const regName = (Object.values(reg.subjects || {}).find((x) => x && x.name && slugOf(x.name) === slugOf(concept.subject)) || {}).name;
        const map = readJson(topicMapFile(regName || concept.subject), null) || readJson(topicMapFile(concept.subject), null);
        if (m.topic && !(map && (map.topics || []).some((t) => t.id === m.topic))) throw new Error("that topic isn't on the course map");
        const file = path.join(dataDir(), "topic-links.json");
        const links = readJson(file, {}, true);
        if (m.topic) links[m.conceptId] = { topic: m.topic, confirmed: true };
        else delete links[m.conceptId];
        writeJsonAtomic(file, links);
        return this.refresh();
      }
      case "renameTopic": {
        const title = String(m.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const file = topicMapFile(m.subject);
        const map = readJson(file, null, true);
        const t = map && (map.topics || []).find((x) => x.id === m.topicId);
        if (!t || !title) return this.refresh();
        t.title = title;
        writeJsonAtomic(file, { ...map, updatedAt: new Date().toISOString() });
        return this.refresh();
      }
      case "openFile":
        if (m.which === "progress") return this.controller.openFile(path.join(home(), "Tutor", "Progress.md"));
        return;
    }
  }

  // Dashboard actions run in the chat, in the right subject.
  async runAction(m) {
    const prompt = actionPrompt(m);
    if (!prompt || this.busy) return;
    const c = this.controller;
    c.reveal();
    if (c.running) {
      // Never steer an action into a reply (or a quiz) that's in progress.
      c.post({ type: "notice", level: "warning", text: "TutorBot is in the middle of something. Finish or stop it, then use the dashboard button again." });
      return;
    }
    this.busy = true;
    try {
      const starting = !(c.proc && c.proc.running);
      await c.ensureStarted();
      // A fresh start restores the last session: learn its subject first.
      if (starting) await waitFor(() => c.subject !== null || c.resets > 0, 8000);
      if (m.subject && c.subject !== m.subject) {
        c.post({ type: "notice", level: "info", text: `Switching to ${m.subject}…` });
        await c.onWebview({ type: "send", text: `/home ${m.subject} --continue` });
        const ok = await waitFor(() => c.subject === m.subject, 15000);
        if (!ok) {
          c.post({ type: "notice", level: "warning", text: `Couldn't switch to ${m.subject}. Pick it from Home, then try again.` });
          return;
        }
        // The subject arrives with the session switch (or right away when it's
        // the current session); just let any startup turn settle.
        await waitFor(() => !c.running, 10000);
      }
      await c.onWebview({ type: "send", text: prompt });
    } finally {
      this.busy = false;
    }
  }
}

function waitFor(cond, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (cond() ? resolve(true) : Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 200));
    tick();
  });
}

const list = (xs) => xs.map((x) => `"${x}"`).join(", ");
function actionPrompt(m) {
  const concepts = (Array.isArray(m.concepts) ? m.concepts : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 12);
  if (["check", "practice", "checkpoint"].includes(m.action) && !concepts.length) return undefined;
  if (m.action === "teach" && !m.topic) return undefined;
  switch (m.action) {
    case "teach":
      return `Teach me "${m.topic}" from my ${m.subject} course${m.topicId && !m.topicId.startsWith("family:") ? ` (course map topic id: ${m.topicId}; tag what you teach with it)` : ""}. Use my class materials if they cover it.`;
    case "check":
      return `Check whether I already know ${list(concepts)} in ${m.subject}: ask me 1–2 graded questions each (purpose "check"), no teaching first unless I miss.`;
    case "practice":
      return `Targeted practice for ${m.subject} on ${list(concepts)}: 3–4 graded review questions (purpose "review"), mixed so I have to pick the technique. Hints are fine if I ask.`;
    case "checkpoint":
      return `No-help checkpoint for ${m.subject} on ${list(concepts)}: one question each, purpose "checkpoint", no hints, no teaching until the end.`;
    case "review":
      return "/review";
    case "courseMap":
      return "/course-map";
    case "folder":
      return "/folder";
  }
  return undefined;
}

// ── chat view ──────────────────────────────────────────────────────────────
class ChatViewProvider {
  constructor(context, controller) {
    this.context = context;
    this.controller = controller;
  }

  resolveWebviewView(view) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const uri = (p) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, p)).toString();
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const csp = [
      "default-src 'none'",
      `img-src ${view.webview.cspSource} data:`,
      `font-src ${view.webview.cspSource}`,
      `style-src ${view.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    view.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("vendor/katex.min.css")}">
<link rel="stylesheet" href="${uri("chat.css")}">
<title>TutorBot</title></head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri("vendor/katex.min.js")}"></script>
<script nonce="${nonce}" src="${uri("vendor/markdown-it.min.js")}"></script>
<script nonce="${nonce}" src="${uri("vendor/highlight.min.js")}"></script>
<script nonce="${nonce}" src="${uri("chat.js")}"></script>
</body></html>`;
    this.controller.attach(view);
  }
}

// ── activation ─────────────────────────────────────────────────────────────
let controller;
function activate(context) {
  output = vscode.window.createOutputChannel("TutorBot");
  secrets = context.secrets;
  extensionRoot = context.extensionPath;
  context.subscriptions.push(output);
  controller = new Controller(context);
  const provider = new ChatViewProvider(context, controller);
  const dashboard = new DashboardPanel(context, controller);
  controller.dashboard = dashboard;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("tutorbot.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("tutorbot.focus", () => controller.reveal()),
    vscode.commands.registerCommand("tutorbot.launch", () => controller.reveal()),
    vscode.commands.registerCommand("tutorbot.newChat", () => controller.newChat()),
    vscode.commands.registerCommand("tutorbot.conversations", () => {
      controller.reveal();
      controller.post({ type: "showConvos" });
    }),
    vscode.commands.registerCommand("tutorbot.home", () => {
      controller.reveal();
      controller.onWebview({ type: "home" });
    }),
    vscode.commands.registerCommand("tutorbot.restart", () => controller.restart()),
    vscode.commands.registerCommand("tutorbot.chooseModel", () => controller.chooseModel()),
    vscode.commands.registerCommand("tutorbot.connectApiKey", () => controller.connectApiKey()),
    vscode.commands.registerCommand("tutorbot.removeApiKey", () => controller.removeApiKey()),
    vscode.commands.registerCommand("tutorbot.submit", () => controller.submit()),
    vscode.commands.registerCommand("tutorbot.hint", () => controller.hint()),
    vscode.commands.registerCommand("tutorbot.ask", () => controller.askAboutSelection()),
    vscode.commands.registerCommand("tutorbot.openExercise", () => controller.exercise && controller.openFile(controller.exercise.file)),
    vscode.commands.registerCommand("tutorbot.showLog", () => output.show(true)),
    vscode.commands.registerCommand("tutorbot.dashboard", () => dashboard.open()),
    { dispose: () => dashboard.panel && dashboard.panel.dispose() },
    vscode.window.onDidChangeActiveColorTheme((t) => dashboard.panel && dashboard.panel.webview.postMessage({ type: "theme", kind: t.kind })),
    vscode.workspace.onDidChangeTextDocument((e) => controller.onType(e)),
    vscode.window.onDidChangeActiveTextEditor(() => controller.updateExerciseContext()),
    vscode.window.onDidChangeActiveColorTheme((t) => controller.post({ type: "theme", kind: t.kind })),
    { dispose: () => controller.dispose() },
  );
  // Study nudge: shortly after startup, then every 3 hours.
  const nudge = () => controller.checkNudge(context);
  const first = setTimeout(nudge, 8000);
  const every = setInterval(nudge, 3 * 3600 * 1000);
  context.subscriptions.push({ dispose: () => (clearTimeout(first), clearInterval(every)) });
}

function deactivate() {
  if (controller) controller.dispose();
}

module.exports = { activate, deactivate };
