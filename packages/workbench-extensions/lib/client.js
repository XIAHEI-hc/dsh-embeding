window.__ModuleLoader__.load({
	id: "@dsh-workbench/extensions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const KEY = "dsh.embed.pending.v1";
		const PROTOCOL = "dsh.embed";
		const VERSION = "1.0";
		const knownError = (error) => error instanceof Error ? error.message : String(error);
		function loadState() {
			const raw = sessionStorage.getItem(KEY);
			if (raw === null) return;
			try {
				const value = JSON.parse(raw);
				if (value?.protocol !== PROTOCOL || value?.version !== VERSION
					|| typeof value.workspace_id !== "string" || typeof value.parent_origin !== "string"
					|| typeof value.channel_id !== "string" || typeof value.request_id !== "string"
					|| !["grant", "workspace", "session"].includes(value.session_binding)) return;
				return value;
			} catch { return; }
		}
		function send(state, type, payload) {
			parent.postMessage({ protocol: PROTOCOL, version: VERSION, type,
				channel_id: state.channel_id, request_id: state.request_id, payload }, state.parent_origin);
		}
		function integrationPayload(state) {
			return typeof state.context_id === "string" ? { context_id: state.context_id } : {};
		}
		function save(state) { sessionStorage.setItem(KEY, JSON.stringify(state)); }
		function forceFreshNativeSessions(ctx) {
			const original = ctx.uiWorkspace.connectWorkspace;
			const create = (workspaceId) => ctx.sessions.create({ workspaceId });
			ctx.uiWorkspace.connectWorkspace = create;
			return () => {
				if (ctx.uiWorkspace.connectWorkspace === create) ctx.uiWorkspace.connectWorkspace = original;
			};
		}
		function applyDraft(ctx, state, sessionId) {
			if (state.prompt_applied || typeof state.initial_prompt !== "string" || state.initial_prompt.length === 0) return;
			const binding = ctx.sessions.binding(sessionId);
			if (binding === undefined) throw new Error(`embed-client: session ${sessionId} has no active binding`);
			const input = ctx.conversation.input.for(binding.ctx);
			if (input.state.getSnapshot().draft === "") input.setDraft(state.initial_prompt);
			state.prompt_applied = true;
			save(state);
		}
		function waitForWorkspace(ctx, workspaceId, timeoutMs = 15000) {
			const present = () => ctx.workspaces.list.getSnapshot().items
				.find((item) => item.workspaceId === workspaceId);
			const current = present();
			if (current !== undefined) return Promise.resolve(current);
			return new Promise((resolve, reject) => {
				let dispose;
				const finish = (error, workspace) => {
					clearTimeout(timer);
					dispose?.();
					error === undefined ? resolve(workspace) : reject(error);
				};
				const timer = setTimeout(() => finish(new Error("WORKSPACE_NOT_FOUND")), timeoutMs);
				dispose = ctx.workspaces.list.subscribe(() => {
					const workspace = present();
					if (workspace !== undefined) finish(undefined, workspace);
				});
				const workspace = present();
				if (workspace !== undefined) finish(undefined, workspace);
			});
		}
		function waitForSessionBinding(ctx, workspaceId, sessionId, timeoutMs = 15000) {
			const present = () => {
				const session = ctx.sessions.list.getSnapshot().byId[sessionId];
				const workspace = ctx.workspaces.list.getSnapshot().items
					.find((item) => item.workspaceId === workspaceId);
				return session !== undefined && workspace?.sessionIds.includes(sessionId) === true;
			};
			if (present()) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const disposers = [];
				const finish = (error) => {
					clearTimeout(timer);
					for (const dispose of disposers) dispose();
					error === undefined ? resolve() : reject(error);
				};
				const inspect = () => { if (present()) finish(); };
				const timer = setTimeout(() => finish(new Error("SESSION_NOT_FOUND")), timeoutMs);
				disposers.push(ctx.sessions.list.subscribe(inspect), ctx.workspaces.list.subscribe(inspect));
				inspect();
			});
		}
		async function initialize(ctx, state) {
			await waitForWorkspace(ctx, state.workspace_id);
			let sessionId;
			if (state.session_binding === "grant" || state.session_binding === "session") {
				sessionId = state.session_id;
				if (typeof sessionId !== "string") throw new Error("SESSION_NOT_FOUND");
				await ctx.sessions.refresh();
				await waitForSessionBinding(ctx, state.workspace_id, sessionId);
				ctx.uiWorkspace.openSession(sessionId);
				applyDraft(ctx, state, sessionId);
			} else {
				sessionId = await ctx.uiWorkspace.connectWorkspace(state.workspace_id);
				state.session_id = sessionId;
				state.session_binding = "session";
				save(state);
				ctx.uiWorkspace.openSession(sessionId);
				applyDraft(ctx, state, sessionId);
			}
			state.session_id = sessionId ?? null;
			save(state);
			send(state, "initialized", { workspace_id: state.workspace_id, session_id: state.session_id,
				mode: state.mode, capabilities: state.capabilities });
			if (typeof sessionId === "string") send(state, "session.opened", {
				workspace_id: state.workspace_id, session_id: sessionId,
			});
		}
		function observeSessionLifecycle(ctx, state) {
			let selected;
			let sessions = new Map();
			let archived = new Set();
			let catalogInitialized = false;
			let archiveInitialized = false;
			const inspectSelection = () => {
				const sessionId = ctx.uiWorkspace.selection?.getSnapshot()?.sessionId;
				if (typeof sessionId !== "string" || sessionId === selected) return;
				const workspace = ctx.workspaces.list.getSnapshot().items
					.find((item) => item.sessionIds.includes(sessionId));
				if (workspace?.workspaceId !== state.workspace_id) return;
				selected = sessionId;
				state.session_id = sessionId;
				state.session_binding = "session";
				save(state);
				send(state, "session.opened", {
					workspace_id: state.workspace_id,
					session_id: sessionId,
					...integrationPayload(state),
				});
			};
			const inspectCatalog = () => {
				const snapshot = ctx.sessions.list.getSnapshot();
				if (snapshot.phase !== "ready") return;
				const next = new Map(snapshot.ids.map((id) => [id, snapshot.byId[id]]));
				if (!catalogInitialized) {
					sessions = next;
					catalogInitialized = true;
					return;
				}
				for (const [id, summary] of next) {
					if (!sessions.has(id) && typeof summary?.parentId === "string") {
						send(state, "session.lifecycle", {
							action: "forked", session_id: id, parent_session_id: summary.parentId,
							...integrationPayload(state),
						});
					}
				}
				for (const id of sessions.keys()) {
					if (!next.has(id)) send(state, "session.lifecycle", {
						action: "deleted", session_id: id, ...integrationPayload(state),
					});
				}
				sessions = next;
			};
			const inspectArchived = () => {
				const next = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds);
				if (!archiveInitialized) {
					archived = next;
					archiveInitialized = true;
					return;
				}
				for (const id of next) if (!archived.has(id)) send(state, "session.lifecycle", {
					action: "archived", session_id: id, ...integrationPayload(state),
				});
				for (const id of archived) if (!next.has(id)) send(state, "session.lifecycle", {
					action: "unarchived", session_id: id, ...integrationPayload(state),
				});
				archived = next;
			};
			inspectCatalog();
			inspectArchived();
			inspectSelection();
			const disposers = [
				ctx.sessions.list.subscribe(() => { inspectCatalog(); inspectSelection(); }),
				ctx.workspaces.list.subscribe(() => { inspectArchived(); inspectSelection(); }),
			];
			if (ctx.uiWorkspace.selection?.subscribe) {
				disposers.push(ctx.uiWorkspace.selection.subscribe(inspectSelection));
			}
			return () => { for (const dispose of disposers) dispose(); };
		}
		const inject = ["connection", "sessions", "workspaces", "uiWorkspace", "conversation"];
		function apply(ctx) {
			const state = loadState();
			if (state === undefined) return;
			const disposeFreshSessions = forceFreshNativeSessions(ctx);
			ctx.effect(() => disposeFreshSessions, "workbench embed fresh native sessions");
			const connection = () => {
				const current = ctx.connection.state.getSnapshot();
				send(state, "connection.changed", {
					state: current === "connecting" || current === undefined ? "reconnecting" : current,
				});
			};
			const disposeConnection = ctx.connection.state.subscribe(connection);
			connection();
			ctx.effect(() => disposeConnection, "workbench embed connection events");
			void initialize(ctx, state).then(() => {
				ctx.effect(() => observeSessionLifecycle(ctx, state), "workbench embed session lifecycle events");
			}).catch((error) => {
				console.error("embed-client initialization failed", error);
				send(state, "error", {
					code: knownError(error).includes("SESSION_NOT_FOUND") ? "SESSION_NOT_FOUND" : "WORKSPACE_IO_ERROR",
					message: "无法打开授权的工作区或会话。",
					retryable: true,
					action: "recheck_workspace",
				});
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
