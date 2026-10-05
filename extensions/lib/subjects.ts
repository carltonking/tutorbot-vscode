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
}

interface Registry {
	subjects: Record<string, Subject>;
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

	removeFolder(folder: string): void {
		const r = this.load();
		for (const s of Object.values(r.subjects)) s.folders = s.folders.filter((f) => f !== folder && !f.endsWith(folder));
		this.save(r);
	}

	// Folders for a subject's searches: its own plus the global ones. With no
	// active subject, search everything.
	foldersFor(active: string | undefined, globalFolders: string[]): string[] {
		const subjects = Object.values(this.load().subjects);
		const own = active ? (this.find(active)?.folders ?? []) : subjects.flatMap((s) => s.folders);
		return [...new Set([...globalFolders, ...own])].filter((f) => existsSync(f));
	}

	allFolders(globalFolders: string[]): string[] {
		return [...new Set([...globalFolders, ...Object.values(this.load().subjects).flatMap((s) => s.folders)])].filter((f) => existsSync(f));
	}
}
