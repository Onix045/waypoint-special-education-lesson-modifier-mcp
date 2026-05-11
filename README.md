# Waypoint Special Education Lesson Modifier (MCP)

TypeScript MCP server for **one lesson PDF** and **one IEP PDF**.

The server exposes lesson/IEP resources plus tools and a prompt contract that force
student-specific, classroom-ready lesson modifications.

## Current Behavior

- Loads the first `.pdf` (alphabetical) in `lesson/`.
- Loads the first `.pdf` (alphabetical) in `iep/`.
- Extracts sectioned text (summary, goals, accommodations, objectives, reading supports).
- Provides a strict instruction contract that requires:
  - 3 critical mismatches
  - task rewrites for reading, independent practice, discussion
  - concrete scaffolds (vocabulary, sentence starters, organizer)
  - 2 proactive behavior supports
  - concise output (300-400 words)

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Add PDFs

- Place one lesson file in `lesson/` (example: `lesson.pdf`)
- Place one IEP file in `iep/` (example: `iep.pdf`)

If multiple PDFs exist in either folder, the server uses the alphabetically first file.

### 3) Run

Development mode:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

## Claude Desktop Configuration

Use absolute paths and set `cwd` to this project root:

```json
{
  "mcpServers": {
    "waypoint-special-ed": {
      "command": "node",
      "args": ["/absolute/path/to/MCP(education)/dist/server.js"],
      "cwd": "/absolute/path/to/MCP(education)"
    }
  }
}
```

Development config:

```json
{
  "mcpServers": {
    "waypoint-special-ed-dev": {
      "command": "npx",
      "args": ["tsx", "watch", "src/server.ts"],
      "cwd": "/absolute/path/to/MCP(education)"
    }
  }
}
```

## Resources

- `waypoint://instructions/special_ed_response`
- `waypoint://index/documents`
- `waypoint://context/grounding_packet`
- `waypoint://lesson/full_text`
- `waypoint://lesson/objectives`
- `waypoint://iep/summary`
- `waypoint://iep/goals`
- `waypoint://iep/accommodations`
- `waypoint://iep/reading_supports`

## Tools

- `ping`
- `reload_documents`
- `get_grounding_packet`
- `get_iep_summary`
- `get_iep_goals`
- `get_iep_accommodations`
- `get_lesson_objectives`
- `get_accommodations_for_reading`

## Prompt

- `generate_modified_lesson_plan`
  - Arg: `studentName` (default: `Student`)
  - Injects the strict lesson-modification output contract.

## Validation

```bash
npm run typecheck
npm run build
```

## License

MIT
