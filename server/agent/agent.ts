/**
 * agent/agent.ts
 * The conversation loop: a turn in, a spoken reply plus a list of UI
 * actions out.
 *
 * Grounding is the whole design. The model is told, firmly, that it does
 * not know these postings -- most went up in the last few weeks and are in
 * nobody's training data -- and that it must call lookupRole/lookupCompany
 * before describing anything. That rule exists because this page gets used
 * to prepare for interviews: a confident invention about what a team is
 * building is worse than "I don't have that."
 */

import type Database from "better-sqlite3";
import { chat, type ChatMessage } from "./providers.js";
import { ACTION_TOOLS, TOOL_SCHEMAS, runTool } from "./tools.js";

// One user turn can need a few tool calls (look up the company, then the
// role, then move the map). Past this it's looping, not working.
const MAX_TOOL_ROUNDS = 4;

export interface ScreenState {
  view: "map" | "role";
  selectedCompany?: { name: string; slug: string } | null;
  openRole?: { id: number; title: string; companySlug: string } | null;
  filters?: Record<string, unknown> | null;
  visibleRoleCount?: number | null;
  /** The city the map was last sent to, so "there" and "here" resolve. */
  mapFocus?: { city: string; state: string } | null;
}

export interface AgentTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentResponse {
  reply: string;
  actions: Array<{ name: string; args: Record<string, unknown> }>;
  usedTools: string[];
}

export function voiceInstructions(screen: ScreenState): string {
  return [
    "You are the voice copilot for Tolara Scout, a map of open Product Manager roles in the US.",
    "You help someone explore the map by talking to them: moving the map, filtering roles, opening a role, and answering questions about companies and jobs.",
    "",
    "RULE ONE: never speak before you act. Call the tool, then say what happened in one short sentence.",
    "Forbidden openings: 'Let me...', 'Got it, let me...', 'Sure thing...', 'Nice, let me...'. Stay silent until the tool returns.",
    "",
    "GROUNDING — this matters more than anything else:",
    "- You do NOT know these job postings. Most were posted in the last few weeks and are not in your training data.",
    "- Before describing what a role involves, what a team builds, or what a company is hiring for, you MUST call lookupRole or lookupCompany and answer only from what comes back.",
    "- The role description returned by lookupRole is the posting's own text. Quote and paraphrase it. It is the only real source for what the job is.",
    "- If a lookup returns nothing useful, say so plainly. Never fill the gap with general knowledge about the company, and never guess a salary, a team or a responsibility.",
    "- Some boards publish no posting text at all. Say it the way a person would -- 'their board doesn't include a description for this one, so the posting itself is the place to look' -- never 'the description field is empty'. Don't describe our data structures.",
    "- You may use general knowledge to say what a company broadly does, but say that you're doing so, and never mix it into a description of the job itself.",
    "- ONE exception: scoreResumeFit returns a score to read out as-is. Give the number and its strengths and gaps in a sentence or two. Don't caveat it, and don't claim to have read a resume file either -- just deliver the result.",
    "",
    "STYLE — you are being listened to, not read:",
    "- Two or three sentences. No lists, no markdown, no headings.",
    "- Never offer to try something you can just do -- do it, then say you did.",
    "- Say numbers the way a person would: 'about a hundred and sixty five thousand', not '$165,000'.",
    "- If a company name was probably misheard and there are near matches, ask which one rather than guessing.",
    "",
    "ACTIONS:",
    "- To move the map, filter, or open something, call the matching tool. The app performs it immediately.",
    "- Call lookupCompany before showCompany, and lookupRole before openRole, so you're using real ids.",
    "- Do ONLY what was asked. Never clear or change filters the user didn't mention -- they may have set them deliberately, and silently undoing that is worse than doing nothing.",
    "- When asked to open a company or a role and exactly one thing matches, open it rather than listing options. Only ask which one when there is genuine ambiguity.",
    "- One action per request is usually right. Don't chain extras to be helpful.",
    "",
    "WHAT IS ON SCREEN RIGHT NOW:",
    JSON.stringify(screen),
    "Resolve 'this role' or 'this company' against that. If nothing is open and the user says 'this', ask what they mean.",
    "This block is refreshed as the user navigates, so trust it over anything you said earlier in the conversation.",
    "You cannot see the screen -- only this block. Never describe what is or isn't visible, whether a panel rendered, or whether something is 'still loading'. Say what you did and what the data says.",
    "mapFocus is the city the map is currently looking at -- resolve 'there', 'here' and 'that city' against it without asking again. If it is null, then ask.",
  ].join("\n");
}

export async function runAgent(
  db: Database.Database,
  utterance: string,
  history: AgentTurn[],
  screen: ScreenState,
): Promise<AgentResponse> {
  const messages: ChatMessage[] = [
    { role: "system", content: voiceInstructions(screen) },
    // Only the recent past: a voice session wanders, and old turns cost
    // tokens on a free tier without helping.
    ...history.slice(-6).map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
    { role: "user", content: utterance },
  ];

  const actions: AgentResponse["actions"] = [];
  const usedTools: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await chat(messages, TOOL_SCHEMAS);

    if (result.toolCalls.length === 0) {
      return { reply: result.content?.trim() || "I didn't catch that — could you say it again?", actions, usedTools };
    }

    messages.push({
      role: "assistant",
      content: result.content ?? null,
      tool_calls: result.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        // Replayed verbatim -- Gemini 3.x rejects the next turn without its
        // thought_signature. See ChatResult.passthrough.
        ...c.passthrough,
      })),
    });

    for (const call of result.toolCalls) {
      usedTools.push(call.name);
      const outcome = await runTool(db, call.name, call.arguments, {
        openRoleId: screen.openRole?.id ?? null,
        // Only the ROLE page can act on a loadIntelligence action -- it owns
        // the button and the cards. A company panel on the map can't, so
        // that case must warm server-side instead or nothing happens at all.
        openCompanySlug: screen.openRole?.companySlug ?? null,
      });
      // Checked against the ACTION it emitted, not the tool that was
      // called: a lookup tool can still ask the browser to do something
      // (lookupCompany pressing "Load company intelligence"), and matching
      // on call.name silently dropped those.
      if (outcome.action && ACTION_TOOLS.has(outcome.action.name)) actions.push(outcome.action);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.result) });
    }
  }

  // Out of rounds with tools still pending: ask for a final answer with no
  // tools on offer, so the turn always ends with something to say.
  const final = await chat(messages, []);
  return {
    reply: final.content?.trim() || "I looked that up but couldn't put an answer together — try asking a different way?",
    actions,
    usedTools,
  };
}
