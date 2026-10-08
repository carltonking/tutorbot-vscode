import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slug } from "./tutor-store.ts";

// ────────────────────────────────────────────────────────────────────────────
// subjects — the learner's list of subjects (classes) and, for each, the last
// pi session used for it and its own class-material folders. Each pi session is
// tagged with the subject it belongs to via a "tutor-subject" session entry.
// ────────────────────────────────────────────────────────────────────────────

export interface Subject {
	name: string;
	createdAt: string;
	lastUsed?: string;
	lastSession?: string;
	folders: string[];
	// The subject folder it's filed under ("Fall 2026", "NYU"…), if any. Not to
	// be confused with `folders`, its class-material folders.
	group?: string;
}

interface Registry {
	subjects: Record<string, Subject>;
	// Subject folders, in the learner's order (empty ones included).
	groups?: string[];
	// Old slug → new slug, so sessions tagged before a rename still resolve.
	aliases?: Record<string, string>;
}

export class SubjectRegistry {
	private path: string;

	constructor(dataDir: string) {
		this.path = join(dataDir, "subjects.json");
	}

	load(): Registry {
		try {
			return JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			return { subjects: {} };
		}
	}

	private save(r: Registry): void {
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(r, null, 2));
		renameSync(tmp, this.path);
	}

	list(): Subject[] {
		return Object.values(this.load().subjects).sort((a, b) => (b.lastUsed ?? b.createdAt).localeCompare(a.lastUsed ?? a.createdAt));
	}

	// Follow rename aliases to the subject's current key.
	private canonicalKey(r: Registry, key: string): string {
		for (let i = 0; i < 10 && !r.subjects[key] && r.aliases?.[key]; i++) key = r.aliases[key];
		return key;
	}

	find(name: string): Subject | undefined {
		const r = this.load();
		const s = this.canonicalKey(r, slug(name));
		return r.subjects[s] ?? Object.values(r.subjects).find((x) => slug(x.name).startsWith(s) || s.startsWith(slug(x.name)));
	}

	// Exact match only (or a renamed subject's old name): find() also matches prefixes.
	has(name: string): boolean {
		const r = this.load();
		return Boolean(r.subjects[this.canonicalKey(r, slug(name))]);
	}

	// Take a subject off the list. Its old names stop resolving to it.
	remove(name: string): Subject | undefined {
		const r = this.load();
		const key = this.canonicalKey(r, slug(name));
		const s = r.subjects[key];
		if (!s) return undefined;
		delete r.subjects[key];
		for (const k of Object.keys(r.aliases ?? {})) if (r.aliases![k] === key) delete r.aliases![k];
		this.save(r);
		return s;
	}

	// A subject's current display name (a renamed subject's old name maps to the new one).
	resolve(name: string): string {
		const r = this.load();
		return r.subjects[this.canonicalKey(r, slug(name))]?.name ?? name;
	}

	// Rename a subject in place. Its folders, sessions and history move with it;
	// the old name stays as an alias. Refuses to collide with another subject.
	rename(from: string, to: string): Subject {
		const r = this.load();
		const name = to.trim();
		const fromKey = this.canonicalKey(r, slug(from));
		const toKey = slug(name);
		const s = r.subjects[fromKey];
		if (!s) throw new Error(`No subject named "${from}".`);
		if (!toKey) throw new Error("The new name needs at least one letter or digit.");
		if (toKey !== fromKey && r.subjects[toKey]) throw new Error(`A subject named "${r.subjects[toKey].name}" already exists.`);
		delete r.subjects[fromKey];
		s.name = name;
		r.subjects[toKey] = s;
		if (toKey !== fromKey) {
			r.aliases ??= {};
			for (const k of Object.keys(r.aliases)) if (r.aliases[k] === fromKey) r.aliases[k] = toKey;
			r.aliases[fromKey] = toKey;
			delete r.aliases[toKey];
		}
		this.save(r);
		return s;
	}

	ensure(name: string): Subject {
		const r = this.load();
		const key = this.canonicalKey(r, slug(name));
		r.subjects[key] ??= { name: name.trim(), createdAt: new Date().toISOString(), folders: [] };
		this.save(r);
		return r.subjects[key];
	}

	update(name: string, patch: Partial<Subject>): Subject {
		const r = this.load();
		const key = this.canonicalKey(r, slug(name));
		const s = (r.subjects[key] ??= { name: name.trim(), createdAt: new Date().toISOString(), folders: [] });
		Object.assign(s, patch);
		this.save(r);
		return s;
	}

	addFolder(name: string, folder: string): void {
		const s = this.ensure(name);
		if (!s.folders.includes(folder)) this.update(name, { folders: [...s.folders, folder] });
	}

	// Stop using a folder for one subject, or for every subject when none is given.
	removeFolder(folder: string, subject?: string): void {
		const r = this.load();
		const targets = subject ? [r.subjects[this.canonicalKey(r, slug(subject))]].filter(Boolean) : Object.values(r.subjects);
		for (const s of targets) s.folders = s.folders.filter((f) => f !== folder && !f.endsWith(folder));
		this.save(r);
	}

	// Folders for a subject's searches: its own plus the global ones. With no
	// active subject, search everything.
	foldersFor(active: string | undefined, globalFolders: string[]): string[] {
		const subjects = Object.values(this.load().subjects);
		const own = active ? (this.find(active)?.folders ?? []) : subjects.flatMap((s) => s.folders);
		return [...new Set([...globalFolders, ...own])].filter((f) => existsSync(f));
	}

	// ── subject folders (groups of subjects) ─────────────────────────────────

	// Folder names in order; a folder only a subject mentions is included too.
	groups(): string[] {
		const r = this.load();
		const out = [...(r.groups ?? [])];
		for (const s of Object.values(r.subjects)) if (s.group && !out.some((g) => sameGroup(g, s.group!))) out.push(s.group);
		return out;
	}

	// Subjects in a folder (undefined: subjects in no folder), most recent first.
	inGroup(group: string | undefined): Subject[] {
		return this.list().filter((s) => (group === undefined ? !s.group : Boolean(s.group) && sameGroup(s.group!, group)));
	}

	createGroup(name: string): string {
		const n = groupName(name);
		const r = this.load();
		const existing = (r.groups ?? []).find((g) => sameGroup(g, n));
		if (existing) return existing;
		r.groups = [...(r.groups ?? []), n];
		this.save(r);
		return n;
	}

	// Rename a folder; its subjects follow. Refuses to collide with another folder.
	renameGroup(from: string, to: string): string {
		const n = groupName(to);
		const r = this.load();
		const all = [...(r.groups ?? []), ...Object.values(r.subjects).flatMap((s) => (s.group ? [s.group] : []))];
		if (!all.some((g) => sameGroup(g, from))) throw new Error(`No folder named "${from}".`);
		if (!sameGroup(from, n) && all.some((g) => sameGroup(g, n))) throw new Error(`A folder named "${n}" already exists.`);
		r.groups = (r.groups ?? []).map((g) => (sameGroup(g, from) ? n : g));
		if (!r.groups.some((g) => sameGroup(g, n))) r.groups.push(n);
		for (const s of Object.values(r.subjects)) if (s.group && sameGroup(s.group, from)) s.group = n;
		this.save(r);
		return n;
	}

	// Delete a folder. Its subjects aren't deleted: they move out to the top level.
	deleteGroup(name: string): number {
		const r = this.load();
		r.groups = (r.groups ?? []).filter((g) => !sameGroup(g, name));
		let moved = 0;
		for (const s of Object.values(r.subjects))
			if (s.group && sameGroup(s.group, name)) {
				delete s.group;
				moved++;
			}
		this.save(r);
		return moved;
	}

	// File a subject under a folder (created if new), or take it out (undefined).
	setGroup(subject: string, group: string | undefined): Subject {
		const r = this.load();
		const s = r.subjects[this.canonicalKey(r, slug(subject))];
		if (!s) throw new Error(`No subject named "${subject}".`);
		if (group === undefined || !group.trim()) delete s.group;
		else {
			const n = groupName(group);
			const existing = [...(r.groups ?? []), ...Object.values(r.subjects).flatMap((x) => (x.group ? [x.group] : []))].find((g) => sameGroup(g, n));
			s.group = existing ?? n;
			if (!(r.groups ?? []).some((g) => sameGroup(g, s.group!))) r.groups = [...(r.groups ?? []), s.group];
		}
		this.save(r);
		return s;
	}

	allFolders(globalFolders: string[]): string[] {
		return [...new Set([...globalFolders, ...Object.values(this.load().subjects).flatMap((s) => s.folders)])].filter((f) => existsSync(f));
	}
}

function groupName(name: string): string {
	const n = name.replace(/\s+/g, " ").trim();
	if (!n) throw new Error("A folder name needs at least one character.");
	return n.slice(0, 60);
}

// Folder names compare case-insensitively ("nyu" is the "NYU" folder).
function sameGroup(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}
