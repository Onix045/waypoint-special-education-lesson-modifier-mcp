/**
 * Waypoint Special Education MCP Server
 *
 * Serves lesson + IEP PDF content as MCP Resources (chunked for context efficiency)
 * and Tools/Prompts that steer Claude toward specific, teacher-ready modifications
 * grounded in both documents. Logs go to stderr so stdio JSON-RPC stays clean.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import pdfParse from "pdf-parse";
import { z } from "zod";

// --- Server identity (shown to MCP clients) ---

const SERVER_NAME = "waypoint-special-ed";
const SERVER_VERSION = "1.0.0";
const ROOT_DIR = process.cwd();
const LESSON_DIR = path.join(ROOT_DIR, "lesson");
const IEP_DIR = path.join(ROOT_DIR, "iep");

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// --- Output contract for Claude (challenge: quality + structure) ---

const SPECIAL_ED_SYSTEM_INSTRUCTIONS = `You are an expert special education teacher.

Your task: Modify a specific lesson for ONE student using their IEP.

IMPORTANT:
- Do NOT give general advice
- Do NOT summarize
- Do NOT repeat the IEP
- ONLY produce concrete, classroom-ready modifications

You MUST use:
1. The lesson content (tasks, structure, timing)
2. The student's IEP (reading level, behavior, accommodations, goals)

--------------------------------------------------

STEP 1 - Identify 3 Critical Mismatches

Find exact conflicts between:
- lesson task vs student ability
- lesson structure vs student behavior
- lesson difficulty vs student reading level

Write short bullets:
"Mismatch: [lesson task] -> [why student will struggle]"

--------------------------------------------------

STEP 2 - Modify Tasks (REQUIRED)

For EACH major lesson part:
- During Reading
- Independent Practice
- Discussion

You must rewrite the task.

Format:
BEFORE: (original task)
AFTER: (modified version for this student)

Rules:
- If reading level is far below -> break text into chunks
- If low stamina -> reduce task length or split into steps
- If avoidance behavior -> reduce independent load

--------------------------------------------------

STEP 3 - Add Scaffolds (Concrete Only)

Create real materials the teacher can use immediately:

1. Simplified Vocabulary (max 3 terms)
Format:
Word -> Simple definition

2. Sentence Starters (2-3 max)
Example:
"The main idea is ___ because ___."

3. Graphic Organizer (text format)
Example:
[Central Idea]
[Detail 1]
[Detail 2]

DO NOT say "provide" - actually generate them.

--------------------------------------------------

STEP 4 - Add Behavior Supports (Proactive)

Based on IEP behavior needs:

Add 2 specific supports:
- WHEN (timing)
- WHAT teacher does

Example:
"After 5 minutes -> teacher checks in and gives positive feedback"

--------------------------------------------------

STEP 5 - Keep It Usable

- Keep total output under 300-400 words
- Be specific, not detailed explanations
- Everything must be usable without editing

--------------------------------------------------

OUTPUT FORMAT:

1. Mismatches
- bullet list

2. Task Modifications
- BEFORE / AFTER

3. Materials
- vocabulary
- sentence starters
- organizer

4. Behavior Supports
- 2 bullets

--------------------------------------------------

If the student would still struggle, simplify again.`;

// --- Document model ---

type DocumentSections = {
  fullText: string;
  summary: string;
  goals: string;
  accommodations: string;
  objectives: string;
  readingSupports: string;
};

type GroundingPacket = {
  studentName: string;
  files: { lesson: string | null; iep: string | null };
  lesson: {
    objectives: string;
    fullTextPreview: string;
  };
  iep: {
    summary: string;
    goals: string;
    accommodations: string;
    readingSupports: string;
  };
  teacherActionRules: string[];
};

/** Keywords tuned for common K–12 IEP / lesson language (heuristic chunking, not legal parsing). */
const KEYWORDS = {
  iepSummary: [
    "present level",
    "plaafp",
    "strength",
    "need",
    "disability",
    "eligibility",
    "student",
    "concern",
    "performance",
  ],
  lessonSummary: ["lesson", "grade", "standard", "unit", "essential question", "big idea"],
  goals: ["annual goal", "goal", "benchmark", "objective", "target", "skill", "progress"],
  accommodations: [
    "accommodation",
    "modification",
    "supplementary aid",
    "assistive",
    "extended time",
    "preferential",
    "chunk",
    "graphic organizer",
    "read aloud",
    "text-to-speech",
  ],
  lessonObjectives: [
    "objective",
    "learning target",
    "success criteria",
    "students will",
    "swbat",
    "i can",
  ],
  reading: [
    "reading",
    "fluency",
    "comprehension",
    "decoding",
    "phonics",
    "phonemic",
    "lexile",
    "oral reading",
    "guided reading",
  ],
} as const;

const documents: {
  lessonFile?: string;
  iepFile?: string;
  lesson: DocumentSections;
  iep: DocumentSections;
} = {
  lesson: emptySections("No lesson PDF loaded yet."),
  iep: emptySections("No IEP PDF loaded yet."),
};

function emptySections(message: string): DocumentSections {
  return {
    fullText: message,
    summary: message,
    goals: message,
    accommodations: message,
    objectives: message,
    readingSupports: message,
  };
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function shortPreview(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}\n\n...[truncated for brevity]`;
}

/**
 * Pulls richer slices than single-line keyword matches: for each hit line, include
 * a few lines before/after so teachers (and Claude) see usable phrases, not isolated words.
 */
function extractRichSection(
  text: string,
  keywords: readonly string[],
  opts: { maxChars: number; contextBefore?: number; contextAfter?: number }
): string {
  const lines = text.split("\n");
  const lowerKw = keywords.map((k) => k.toLowerCase());
  const keep = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (!lowerKw.some((k) => low.includes(k))) continue;
    const before = opts.contextBefore ?? 2;
    const after = opts.contextAfter ?? 6;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) {
      keep.add(j);
    }
  }

  if (keep.size === 0) {
    return shortPreview(text, opts.maxChars);
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const merged: string[] = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx > prev + 1 && merged.length > 0) merged.push("");
    merged.push(lines[idx]);
    prev = idx;
  }
  return shortPreview(merged.join("\n"), opts.maxChars);
}

function buildSections(text: string, kind: "lesson" | "iep"): DocumentSections {
  const normalized = normalizeText(text);
  const summaryKeywords = kind === "iep" ? KEYWORDS.iepSummary : KEYWORDS.lessonSummary;

  return {
    fullText: shortPreview(normalized, 12_000),
    summary: extractRichSection(normalized, summaryKeywords, { maxChars: 2000 }),
    goals: extractRichSection(normalized, KEYWORDS.goals, { maxChars: 2200 }),
    accommodations: extractRichSection(normalized, KEYWORDS.accommodations, { maxChars: 2200 }),
    objectives: extractRichSection(normalized, KEYWORDS.lessonObjectives, { maxChars: 2200 }),
    readingSupports: extractRichSection(normalized, KEYWORDS.reading, { maxChars: 2200 }),
  };
}

async function firstPdfInDirectory(dirPath: string): Promise<string | undefined> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const pdfFile = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))[0];

  return pdfFile ? path.join(dirPath, pdfFile) : undefined;
}

async function parsePdfText(pdfPath: string): Promise<string> {
  const fileBuffer = await fs.readFile(pdfPath);
  const ttWarningPattern = /^Warning:\s*TT:\s*undefined function:\s*\d+/i;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalError = console.error;

  // pdf-parse/pdf.js can emit noisy font warnings for otherwise readable PDFs.
  // Suppress only this known non-fatal warning while keeping all other warnings visible.
  const shouldSuppress = (args: unknown[]): boolean => {
    const firstArg = args[0];
    return typeof firstArg === "string" && ttWarningPattern.test(firstArg.trim());
  };
  console.warn = (...args: unknown[]) => {
    if (!shouldSuppress(args)) originalWarn(...args);
  };
  console.log = (...args: unknown[]) => {
    if (!shouldSuppress(args)) originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    if (!shouldSuppress(args)) originalError(...args);
  };

  try {
    const parsed = await pdfParse(fileBuffer);
    return normalizeText(parsed.text || "");
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.error = originalError;
  }
}

async function loadDocuments(): Promise<void> {
  try {
    documents.lessonFile = await firstPdfInDirectory(LESSON_DIR);
    documents.iepFile = await firstPdfInDirectory(IEP_DIR);

    if (documents.lessonFile) {
      const lessonText = await parsePdfText(documents.lessonFile);
      documents.lesson = buildSections(lessonText, "lesson");
      console.error(`[docs] Loaded lesson PDF: ${path.basename(documents.lessonFile)}`);
    } else {
      documents.lesson = emptySections(
        "No lesson PDF found. Add exactly one .pdf file to the lesson/ folder (alphabetically first if multiple)."
      );
      console.error("[docs] No lesson PDF found in lesson/.");
    }

    if (documents.iepFile) {
      const iepText = await parsePdfText(documents.iepFile);
      documents.iep = buildSections(iepText, "iep");
      console.error(`[docs] Loaded IEP PDF: ${path.basename(documents.iepFile)}`);
    } else {
      documents.iep = emptySections(
        "No IEP PDF found. Add exactly one .pdf file to the iep/ folder (alphabetically first if multiple)."
      );
      console.error("[docs] No IEP PDF found in iep/.");
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error("[docs] Failed while loading PDF documents:", details);
    documents.lesson = emptySections(`Error loading lesson PDF: ${details}`);
    documents.iep = emptySections(`Error loading IEP PDF: ${details}`);
  }
}

/** Machine-readable index so clients know what to fetch and in what order. */
function buildDocumentIndexJson(): string {
  return JSON.stringify(
    {
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      files: {
        lesson: documents.lessonFile ? path.basename(documents.lessonFile) : null,
        iep: documents.iepFile ? path.basename(documents.iepFile) : null,
      },
      suggestedFlow: [
        "Read waypoint://instructions/special_ed_response",
        "Read waypoint://index/documents for this JSON",
        "Fetch iep/summary, iep/goals, iep/accommodations, lesson/objectives, then lesson/full_text if needed",
        "Use prompt generate_modified_lesson_plan",
      ],
      resources: [
        { uri: "waypoint://instructions/special_ed_response", role: "system_contract" },
        { uri: "waypoint://index/documents", role: "discovery" },
        { uri: "waypoint://lesson/full_text", role: "lesson_body_trimmed" },
        { uri: "waypoint://lesson/objectives", role: "lesson_chunk" },
        { uri: "waypoint://iep/summary", role: "iep_chunk" },
        { uri: "waypoint://iep/goals", role: "iep_chunk" },
        { uri: "waypoint://iep/accommodations", role: "iep_chunk" },
        { uri: "waypoint://iep/reading_supports", role: "iep_chunk_reading" },
      ],
      tools: [
        "ping",
        "get_iep_summary",
        "get_iep_goals",
        "get_iep_accommodations",
        "get_lesson_objectives",
        "get_accommodations_for_reading",
        "get_grounding_packet",
        "reload_documents",
      ],
    },
    null,
    2
  );
}

function buildGroundingPacket(studentName = "Student"): GroundingPacket {
  return {
    studentName,
    files: {
      lesson: documents.lessonFile ? path.basename(documents.lessonFile) : null,
      iep: documents.iepFile ? path.basename(documents.iepFile) : null,
    },
    lesson: {
      objectives: documents.lesson.objectives,
      fullTextPreview: shortPreview(documents.lesson.fullText, 2500),
    },
    iep: {
      summary: documents.iep.summary,
      goals: documents.iep.goals,
      accommodations: documents.iep.accommodations,
      readingSupports: documents.iep.readingSupports,
    },
    teacherActionRules: [
      "Each recommendation must name the lesson task/material it modifies.",
      "Each recommendation must cite an IEP need/goal/accommodation it addresses.",
      "Use implementation-ready teacher language (what to do, when, and with what support).",
      "Prefer 5-8 high-impact modifications over long generic lists.",
    ],
  };
}

function registerResources(): void {
  server.registerResource(
    "special_ed_response_instructions",
    "waypoint://instructions/special_ed_response",
    {
      title: "Special Education Response Instructions",
      description:
        "Role, UDL lens, grounding rules, and exact Markdown template for modified lesson plans.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: SPECIAL_ED_SYSTEM_INSTRUCTIONS,
        },
      ],
    })
  );

  server.registerResource(
    "document_index",
    "waypoint://index/documents",
    {
      title: "Document index",
      description: "JSON list of resources, tools, and suggested read order for Claude.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: buildDocumentIndexJson(),
        },
      ],
    })
  );

  server.registerResource(
    "grounding_packet",
    "waypoint://context/grounding_packet",
    {
      title: "Grounding packet",
      description:
        "Structured lesson + IEP evidence bundle for high-specificity, teacher-ready outputs.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(buildGroundingPacket(), null, 2),
        },
      ],
    })
  );

  server.registerResource(
    "lesson_full_text",
    "waypoint://lesson/full_text",
    {
      title: "Lesson full text (trimmed)",
      description: "Lesson PDF text, capped to limit context dump; use objectives chunk first.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: documents.lesson.fullText }],
    })
  );

  server.registerResource(
    "lesson_objectives",
    "waypoint://lesson/objectives",
    {
      title: "Lesson objectives chunk",
      description: "Heuristic extract around objectives / learning targets / success criteria.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: documents.lesson.objectives }],
    })
  );

  server.registerResource(
    "iep_summary",
    "waypoint://iep/summary",
    {
      title: "IEP summary chunk",
      description: "Heuristic extract around present levels, strengths, needs, student context.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: documents.iep.summary }],
    })
  );

  server.registerResource(
    "iep_goals",
    "waypoint://iep/goals",
    {
      title: "IEP goals chunk",
      description: "Heuristic extract around annual goals, benchmarks, targets.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: documents.iep.goals }],
    })
  );

  server.registerResource(
    "iep_accommodations",
    "waypoint://iep/accommodations",
    {
      title: "IEP accommodations chunk",
      description: "Heuristic extract around accommodations, modifications, supplementary aids.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: documents.iep.accommodations }],
    })
  );

  server.registerResource(
    "iep_reading_supports",
    "waypoint://iep/reading_supports",
    {
      title: "IEP reading-related chunk",
      description: "Reading/fluency/comprehension-related lines for literacy-focused lesson tweaks.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/plain", text: documents.iep.readingSupports },
      ],
    })
  );
}

function registerTools(): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Sanity check that the MCP server is reachable.",
      inputSchema: { message: z.string().optional() },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `pong: ${message?.trim() || "ping"}` }],
    })
  );

  server.registerTool(
    "reload_documents",
    {
      title: "Reload PDFs",
      description:
        "Re-scan lesson/ and iep/ and re-parse PDFs (e.g., after replacing files). Does not require restarting Claude Desktop.",
    },
    async () => {
      await loadDocuments();
      return {
        content: [
          {
            type: "text",
            text: `Reloaded. Lesson: ${documents.lessonFile ? path.basename(documents.lessonFile) : "none"}. IEP: ${documents.iepFile ? path.basename(documents.iepFile) : "none"}.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_grounding_packet",
    {
      title: "Get grounding packet",
      description:
        "Returns a structured JSON payload combining lesson and IEP evidence to reduce generic output.",
      inputSchema: {
        studentName: z.string().optional(),
      },
    },
    async ({ studentName }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(buildGroundingPacket(studentName ?? "Student"), null, 2),
        },
      ],
    })
  );

  server.registerTool(
    "get_iep_summary",
    {
      title: "Get IEP summary chunk",
      description: "Same text as waypoint://iep/summary—quick pull without resource read.",
    },
    async () => ({
      content: [{ type: "text", text: documents.iep.summary }],
    })
  );

  server.registerTool(
    "get_iep_goals",
    {
      title: "Get IEP goals chunk",
      description: "Goals/benchmarks-oriented slice for aligning lesson outcomes to the IEP.",
    },
    async () => ({
      content: [{ type: "text", text: documents.iep.goals }],
    })
  );

  server.registerTool(
    "get_iep_accommodations",
    {
      title: "Get IEP accommodations chunk",
      description: "Accommodations/modifications slice for checklist-style classroom use.",
    },
    async () => ({
      content: [{ type: "text", text: documents.iep.accommodations }],
    })
  );

  server.registerTool(
    "get_lesson_objectives",
    {
      title: "Get lesson objectives chunk",
      description: "Objectives / learning targets slice from the lesson PDF.",
    },
    async () => ({
      content: [{ type: "text", text: documents.lesson.objectives }],
    })
  );

  server.registerTool(
    "get_accommodations_for_reading",
    {
      title: "Get reading-related IEP supports",
      description:
        "Reading/literacy-oriented lines from the IEP—pair with reading-heavy lesson segments.",
    },
    async () => ({
      content: [{ type: "text", text: documents.iep.readingSupports }],
    })
  );
}

function registerPrompts(): void {
  server.registerPrompt(
    "generate_modified_lesson_plan",
    {
      title: "Generate modified lesson plan",
      description:
        "Loads the expert teacher contract and reminds Claude to read chunked resources before answering.",
      argsSchema: {
        studentName: z.string().default("Student"),
      },
    },
    ({ studentName }) => ({
      description:
        "Use lesson + IEP resources to produce one student-specific modified lesson in the required output format.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${SPECIAL_ED_SYSTEM_INSTRUCTIONS}

Student name for the title line: ${studentName}

Before writing:
1) Read waypoint://index/documents (or equivalent resource list from this server).
2) Pull iep/summary, iep/goals, iep/accommodations, lesson/objectives; use lesson/full_text only if you need more lesson detail.
3) Produce the final answer using ONLY the required output format—no extra preamble.`,
          },
        },
      ],
    })
  );
}

async function startServer(): Promise<void> {
  console.error(`[startup] Initializing ${SERVER_NAME} v${SERVER_VERSION}...`);
  await loadDocuments();

  registerResources();
  registerTools();
  registerPrompts();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[startup] MCP server connected over stdio.");
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.error(`[shutdown] Received ${signal}. Closing server...`);
  try {
    await server.close();
    console.error("[shutdown] Server closed cleanly.");
    process.exit(0);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error("[shutdown] Error while closing server:", details);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startServer().catch((error) => {
  const details = error instanceof Error ? error.message : String(error);
  console.error("[fatal] Failed to start MCP server:", details);
  process.exit(1);
});
