import type { SessionTurn } from "../registry/registry.js";
import { escapeMrkdwn } from "./format.js";
import { responseSections } from "./session.js";

type Block = Record<string, unknown>;

export const MODAL_IDS = {
  newAgent: "modal_new_agent",
  picker: "modal_picker",
  reply: "modal_session_reply",
  history: "modal_session_history",
} as const;

export const BLOCK_IDS = {
  herd: "b_herd",
  workspace: "b_workspace",
  directory: "b_directory",
  directoryOther: "b_directory_other",
  kind: "b_kind",
  mode: "b_mode",
  label: "b_label",
  prompt: "b_prompt",
  reply: "b_reply",
} as const;

export const ACTION_IDS = {
  herd: "a_herd",
  /** The button on the "which herd?" step, which carries the id in `value`. */
  herdStep: "a_herd_step",
  workspace: "a_workspace",
  directory: "a_directory",
  directoryOther: "a_directory_other",
  kind: "a_kind",
  mode: "a_mode",
  label: "a_label",
  prompt: "a_prompt",
  reply: "a_reply",
} as const;

/** Every action id that is a form input, so inbound handling can ignore them. */
export const MODAL_INPUT_ACTION_IDS: readonly string[] = Object.values(ACTION_IDS);

/** Slack refuses a static_select with more than 100 options. */
export const OPTION_CAP = 100;

/**
 * Slack also refuses one with *no* options, rejecting the whole view as
 * `invalid_blocks`. That is not hypothetical here: a peer herd advertises its
 * workspaces and agent kinds through its heartbeat, and a herd that has not
 * reported any yet would otherwise render an empty select — the view then fails
 * to update and the modal sits on "Loading…" until it is closed.
 */
const hasOptions = (options: Option[]): boolean => options.length > 0;

const text = (value: string, max = 75): { type: "plain_text"; text: string; emoji: true } => ({
  type: "plain_text",
  // Slack rejects empty or over-long option text outright, which surfaces as an
  // opaque "invalid_blocks" rather than anything actionable.
  text: value.trim().slice(0, max) || "—",
  emoji: true,
});

export interface Option {
  label: string;
  value: string;
}

export function option(o: Option): Block {
  return { text: text(o.label), value: o.value.slice(0, 150) };
}

/**
 * Cap an option list, keeping the first N.
 *
 * Slack hard-caps at 100 and rejects the whole view beyond it, so this is not a
 * nicety — an unpaginated list on a busy machine breaks the modal entirely.
 */
export function capOptions(options: Option[]): Option[] {
  return options.slice(0, OPTION_CAP);
}

function selectBlock(
  blockId: string,
  actionId: string,
  label: string,
  options: Option[],
  opts: {
    optional?: boolean;
    initial?: string | undefined;
    placeholder?: string;
    /**
     * Report the choice as it is made. An input block is silent by default, so
     * without this a picker that other fields depend on never tells us to
     * re-render and the form keeps showing the previous herd's options.
     */
    dispatch?: boolean;
  } = {},
): Block {
  const capped = capOptions(options);
  const initial = capped.find((o) => o.value === opts.initial);
  return {
    type: "input",
    block_id: blockId,
    ...(opts.optional ? { optional: true } : {}),
    ...(opts.dispatch ? { dispatch_action: true } : {}),
    label: text(label),
    element: {
      type: "static_select",
      action_id: actionId,
      placeholder: text(opts.placeholder ?? "Choose one"),
      options: capped.map(option),
      ...(initial ? { initial_option: option(initial) } : {}),
    },
  };
}

function inputBlock(
  blockId: string,
  actionId: string,
  label: string,
  opts: {
    optional?: boolean;
    multiline?: boolean;
    placeholder?: string;
    initial?: string | undefined;
  } = {},
): Block {
  return {
    type: "input",
    block_id: blockId,
    ...(opts.optional ? { optional: true } : {}),
    label: text(label),
    element: {
      type: "plain_text_input",
      action_id: actionId,
      ...(opts.multiline ? { multiline: true } : {}),
      ...(opts.placeholder ? { placeholder: text(opts.placeholder, 150) } : {}),
      ...(opts.initial ? { initial_value: opts.initial } : {}),
    },
  };
}

/**
 * What the form should come back pre-filled with.
 *
 * Launching a second agent is usually a variation on the last one — same
 * workspace, same directory, same kind — so making someone re-pick all of it
 * every time is pure friction.
 */
export interface NewAgentDefaults {
  workspaceId?: string | undefined;
  cwd?: string | undefined;
  typedCwd?: string | undefined;
  kind?: string | undefined;
  /**
   * Carried across a re-render rather than remembered between launches.
   * Changing the herd rebuilds the form, and losing a prompt someone had
   * already typed is a bad trade for a picker sitting above it.
   */
  label?: string | undefined;
  firstPrompt?: string | undefined;
}

/** A herd the form can launch into. */
export interface NewAgentHerd {
  herdId: string;
  label: string;
  agentCount: number;
  reachable: boolean;
}

/**
 * Launch targets, in the shape the form needs.
 *
 * Deliberately not herdr's own types: the options may describe another herd,
 * read from its heartbeat rather than from a socket we can reach.
 */
export interface NewAgentTargets {
  workspaces: { id: string; label: string }[];
  worktrees: { label: string; path: string; branch?: string }[];
  kinds: { kind: string; label: string }[];
}

export interface NewAgentModel extends NewAgentTargets {
  /** Currently selected kind. */
  selectedKind?: string;
  favouriteDirs?: string[];
  defaults?: NewAgentDefaults | undefined;
  /**
   * Herds to choose between. Omitted or single means no picker: there is only
   * one place the agent could start.
   */
  herds?: NewAgentHerd[];
  selectedHerdId?: string | undefined;
}

/**
 * The New agent modal, opened from the Home tab's ＋ New agent button.
 *
 * A skeleton is opened first and this replaces it via views.update, because
 * trigger_id expires in about three seconds and fetching workspaces and
 * worktrees from herdr first would routinely blow that window.
 *
 * Mode options depend on the chosen agent, so the modal is re-rendered on that
 * selection — external_select would need a public HTTPS endpoint, which this
 * project deliberately does not have.
 */
export function buildNewAgentModal(model: NewAgentModel): Record<string, unknown> {
  const kinds = model.kinds.map((entry) => ({
    label: entry.label === entry.kind ? entry.kind : `${entry.label} (${entry.kind})`,
    value: entry.kind,
  }));

  const selected = model.selectedKind ?? model.defaults?.kind ?? model.kinds[0]?.kind ?? "";

  const directories: Option[] = [
    ...(model.favouriteDirs ?? []).map((dir) => ({ label: dir, value: dir })),
    ...model.worktrees.map((tree) => ({
      label: tree.branch ? `${tree.label} (${tree.branch})` : tree.label,
      value: tree.path,
    })),
  ];

  const herds = model.herds ?? [];
  const blocks: Block[] = [];

  // Which machine comes first: everything below it (workspaces, worktrees,
  // agent kinds) is that herd's, so choosing it later would mean re-picking.
  // `dispatch` is what makes the rest of the form follow the choice.
  if (herds.length > 1) {
    blocks.push(
      selectBlock(
        BLOCK_IDS.herd,
        ACTION_IDS.herd,
        "Herd",
        herds.map((herd) => ({
          label: herd.reachable
            ? `${herd.label} (${herd.agentCount} agent${herd.agentCount === 1 ? "" : "s"})`
            : `${herd.label} — unreachable`,
          value: herd.herdId,
        })),
        { dispatch: true, ...(model.selectedHerdId ? { initial: model.selectedHerdId } : {}) },
      ),
    );
  }

  // Nothing to launch into means the form cannot work. Say so rather than
  // rendering a dead one — and rather than an empty select Slack would reject.
  if (kinds.length === 0) {
    blocks.push(note("This herd has not reported any agent kinds yet. Try again in a moment."));
    return { ...shell(model), blocks };
  }

  const workspaces = model.workspaces.map((w) => ({ label: w.label || w.id, value: w.id }));
  if (hasOptions(workspaces)) {
    blocks.push(
      selectBlock(BLOCK_IDS.workspace, ACTION_IDS.workspace, "Workspace", workspaces, {
        optional: true,
        placeholder: "New workspace",
        ...(model.defaults?.workspaceId ? { initial: model.defaults.workspaceId } : {}),
      }),
    );
  }

  if (hasOptions(directories)) {
    blocks.push(
      selectBlock(BLOCK_IDS.directory, ACTION_IDS.directory, "Directory", directories, {
        optional: true,
        // Only if it is still on offer; a worktree can disappear between launches.
        ...(model.defaults?.cwd && directories.some((d) => d.value === model.defaults?.cwd)
          ? { initial: model.defaults.cwd }
          : {}),
      }),
    );
  }

  blocks.push(
    inputBlock(BLOCK_IDS.directoryOther, ACTION_IDS.directoryOther, "…or type a path", {
      optional: true,
      placeholder: "/Users/you/project",
      ...(model.defaults?.typedCwd ? { initial: model.defaults.typedCwd } : {}),
    }),
    selectBlock(BLOCK_IDS.kind, ACTION_IDS.kind, "Agent", kinds, { initial: selected }),
    inputBlock(BLOCK_IDS.label, ACTION_IDS.label, "Tab label", {
      optional: true,
      placeholder: "what this agent is for",
      ...(model.defaults?.label ? { initial: model.defaults.label } : {}),
    }),
    inputBlock(BLOCK_IDS.prompt, ACTION_IDS.prompt, "First prompt", {
      optional: true,
      multiline: true,
      placeholder: "What should it start on?",
      ...(model.defaults?.firstPrompt ? { initial: model.defaults.firstPrompt } : {}),
    }),
  );

  return { ...shell(model), submit: text("Start"), blocks };
}

const note = (message: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: message },
});

function shell(model: NewAgentModel): Block {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    // Carries the target herd even when there is no picker to read it back from.
    private_metadata: model.selectedHerdId ?? "",
    title: text("New agent"),
    close: text("Cancel"),
  };
}

/**
 * Step one when nothing implies a herd.
 *
 * Workspaces, worktrees and agent kinds all belong to a herd, so asking for it
 * up front is the difference between a form and a guess. Opening straight into
 * the full form is better whenever the herd *is* implied — the Home tab is
 * usually already showing one — so this step is skipped in that case.
 */
export function buildHerdChooserModal(herds: NewAgentHerd[]): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    title: text("New agent"),
    close: text("Cancel"),
    blocks: [
      note("*Which herd should run it?*"),
      ...herds.map((herd) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: herd.reachable
            ? `*${escapeMrkdwn(herd.label)}*\n${herd.agentCount} agent${herd.agentCount === 1 ? "" : "s"}`
            : `*${escapeMrkdwn(herd.label)}*\nunreachable — wake the machine and start herdr`,
        },
        // No button for a herd that cannot start anything: offering one would
        // only produce a form that fails on submit.
        ...(herd.reachable
          ? {
              accessory: {
                type: "button",
                action_id: ACTION_IDS.herdStep,
                value: herd.herdId,
                text: text("Choose"),
              },
            }
          : {}),
      })),
    ],
  };
}

/** A modal that only has something to say — used when a form cannot be built. */
export function messageModal(title: string, message: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    title: text(title),
    close: text("Close"),
    blocks: [note(message)],
  };
}

/** Opened immediately so the trigger_id is spent before any herdr call. */
export function skeletonModal(title: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.newAgent,
    title: text(title),
    close: text("Cancel"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Loading…_" } }],
  };
}

export function buildReplyModal(ref: string, title: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_IDS.reply,
    private_metadata: ref,
    title: text("Reply to agent"),
    submit: text("Send"),
    close: text("Cancel"),
    blocks: [
      inputBlock(BLOCK_IDS.reply, ACTION_IDS.reply, title.slice(0, 75), {
        multiline: true,
        placeholder: "Ask for a change or give the next instruction",
      }),
    ],
  };
}

export function parseReplySubmission(view: unknown): string | null {
  const values = (view as ViewState)?.values ?? {};
  const value = values[BLOCK_IDS.reply]?.[ACTION_IDS.reply]?.value?.trim();
  return value || null;
}

const HISTORY_PAGE_ACTION = "session_history_page";

const pageButton = (label: string, ref: string, page: number): Block => ({
  type: "button",
  text: text(label),
  action_id: `${HISTORY_PAGE_ACTION}_${page}`,
  value: ref,
});

/** Slack renders this in the reader's own timezone; the fallback is for exports. */
function whenLine(turn: SessionTurn): string {
  const at = turn.completedAt ?? turn.createdAt;
  const seconds = Math.floor(at / 1_000);
  return `<!date^${seconds}^{date_short_pretty} at {time}|${new Date(at).toISOString()}>`;
}

/**
 * One response per view, newest first.
 *
 * The newest recorded response is the one on the session card, so this list
 * starts one back — "Earlier" means earlier than what you are already looking
 * at, not a duplicate of it. `page` indexes the list, so page 0 is the newest
 * *earlier* response and *Older* walks back through time. Showing turns one at a
 * time is the whole point of this modal: stacked side by side they read as one
 * wall of terminal text, which is what the session card already avoids.
 */
export function buildHistoryModal(
  ref: string,
  turns: SessionTurn[],
  page = 0,
): Record<string, unknown> {
  const newestFirst = turns
    .filter((turn) => turn.response)
    .reverse()
    .slice(1);
  const total = newestFirst.length;
  if (total === 0) {
    return {
      type: "modal",
      callback_id: MODAL_IDS.history,
      private_metadata: ref,
      title: text("Earlier responses"),
      close: text("Close"),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "_No earlier responses yet._" } }],
    };
  }

  const index = Math.min(Math.max(0, page), total - 1);
  const turn = newestFirst[index] as SessionTurn;
  const number = total - index;

  const blocks: Block[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*#${number}* of ${total}${index === 0 ? " · latest" : ""} · ${whenLine(turn)}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*You asked*\n${escapeMrkdwn(turn.prompt).slice(0, 1_200)}` },
    },
    ...responseSections(turn.response ?? ""),
  ];

  const controls: Block[] = [];
  if (index < total - 1) controls.push(pageButton("← Older", ref, index + 1));
  if (index > 0) controls.push(pageButton("Newer →", ref, index - 1));
  if (controls.length > 0)
    blocks.push({ type: "divider" }, { type: "actions", elements: controls });

  return {
    type: "modal",
    callback_id: MODAL_IDS.history,
    private_metadata: ref,
    title: text(`Response #${number} of ${total}`),
    close: text("Close"),
    blocks,
  };
}

export interface NewAgentSubmission {
  workspaceId?: string;
  cwd?: string;
  kind: string;
  label?: string;
  firstPrompt?: string;
  /** Which herd to launch on; absent means the local one. */
  herdId?: string;
}

type ViewState = {
  values?: Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>>;
};

/**
 * What is worth keeping when the form is rebuilt for another herd.
 *
 * Only the herd-independent fields. A workspace or a path belongs to the
 * machine that was selected a moment ago, so carrying those over would put
 * someone else's directory in front of the user as if we had found it.
 */
export function carriedText(viewState: unknown): NewAgentDefaults {
  const values = (viewState as ViewState)?.values ?? {};
  const label = values[BLOCK_IDS.label]?.[ACTION_IDS.label]?.value?.trim();
  const firstPrompt = values[BLOCK_IDS.prompt]?.[ACTION_IDS.prompt]?.value?.trim();
  return { ...(label ? { label } : {}), ...(firstPrompt ? { firstPrompt } : {}) };
}

/**
 * Read a submitted view. Returns null when required fields are missing.
 *
 * `privateMetadata` is the fallback target herd, for the single-herd case where
 * the picker is not rendered at all.
 */
export function parseNewAgentSubmission(
  view: unknown,
  privateMetadata = "",
): NewAgentSubmission | null {
  const values = (view as ViewState)?.values ?? {};
  const pick = (block: string, action: string): string | undefined => {
    const field = values[block]?.[action];
    return field?.selected_option?.value ?? field?.value ?? undefined;
  };

  const kind = pick(BLOCK_IDS.kind, ACTION_IDS.kind);
  if (!kind) return null;

  const herdId = pick(BLOCK_IDS.herd, ACTION_IDS.herd) ?? privateMetadata.trim();

  // A typed path wins over the picker: someone who typed one meant it.
  const typed = pick(BLOCK_IDS.directoryOther, ACTION_IDS.directoryOther)?.trim();
  const picked = pick(BLOCK_IDS.directory, ACTION_IDS.directory);
  const cwd = typed || picked;

  const workspaceId = pick(BLOCK_IDS.workspace, ACTION_IDS.workspace);
  const label = pick(BLOCK_IDS.label, ACTION_IDS.label)?.trim();
  const firstPrompt = pick(BLOCK_IDS.prompt, ACTION_IDS.prompt)?.trim();

  // Fields are omitted rather than set to empty strings, so callers can rely on
  // presence meaning "the user chose something".
  return {
    kind,
    ...(workspaceId ? { workspaceId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(label ? { label } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(herdId ? { herdId } : {}),
  };
}
