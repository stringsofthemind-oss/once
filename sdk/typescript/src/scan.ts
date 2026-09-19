import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  stdin as input,
  stdout as output
} from "node:process";

type Confidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW";

export type Finding = {
  file: string;
  line: number;
  functionName?: string;
  confidence: Confidence;
  category: string;
  reason: string;
};

type ScanResult = {
  root: string;
  filesScanned: number;
  findings: Finding[];
  languages: string[];
  tooling: string[];
};

type Rule = {
  confidence: Confidence;
  category: string;
  reason: string;
  pattern: RegExp;
};

const ignoredDirectories =
  new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".once",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode"
  ]);

const sourceExtensions =
  new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py"
  ]);

const sensitiveNames =
  new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "id_rsa",
    "id_ed25519"
  ]);

const sensitiveExtensions =
  new Set([
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".crt",
    ".cer"
  ]);

const rules: Rule[] = [
  {
    confidence: "HIGH",
    category: "PAYMENT",
    reason:
      "Payment or money-movement operation detected.",
    pattern:
      /\b(paymentIntents|charges|refunds|transfers|payouts)\.(create|update|cancel)\b|\b(charge|refund|capturePayment|createInvoice|sendPayment|createPayout)\w*\s*\(/i
  },
  {
    confidence: "HIGH",
    category: "MESSAGING",
    reason:
      "External message/email/SMS send operation detected.",
    pattern:
      /\b(sendEmail|sendMail|sendMessage|sendSms|sendSMS|postMessage)\w*\s*\(|chat\.postMessage/i
  },
  {
    confidence: "HIGH",
    category: "BOOKING",
    reason:
      "Booking, reservation, appointment or order mutation detected.",
    pattern:
      /\b(create|confirm|cancel|update)(Booking|Reservation|Appointment|Order)\w*\s*\(/i
  },
  {
    confidence: "HIGH",
    category: "HTTP_DELETE",
    reason:
      "Outbound HTTP DELETE operation detected.",
    pattern:
      /method\s*:\s*["']DELETE["']|(?:axios|requests)\.delete\s*\(/i
  },
  {
    confidence: "MEDIUM",
    category: "HTTP_WRITE",
    reason:
      "Outbound HTTP POST/PUT/PATCH operation detected.",
    pattern:
      /method\s*:\s*["'](?:POST|PUT|PATCH)["']|(?:axios|requests)\.(?:post|put|patch)\s*\(/i
  },
  {
    confidence: "HIGH",
    category: "DATABASE",
    reason:
      "Database mutation operation detected.",
    pattern:
      /\bprisma\.[A-Za-z0-9_]+\.(create|update|delete|upsert)\s*\(|\b(?:exec|query|execute)\s*\(\s*["'`][\s\S]{0,300}\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[A-Za-z0-9_"`.]+\s+SET)\b/i
  },
  {
    confidence: "MEDIUM",
    category: "DATABASE",
    reason:
      "Database insert/update/delete/upsert call detected.",
    pattern:
      /\.(insert|upsert|update|delete)\s*\(/i
  },
  {
    confidence: "MEDIUM",
    category: "QUEUE",
    reason:
      "Queue, topic or event publication operation detected.",
    pattern:
      /\b(queue|topic|sqs|sns|pubsub|kafka|producer)[A-Za-z0-9_.$]*.*\.(send|publish|produce|enqueue)\s*\(/i
  },
  {
    confidence: "MEDIUM",
    category: "STORAGE",
    reason:
      "External object-storage write/delete operation detected.",
    pattern:
      /\b(putObject|deleteObject|uploadFile|uploadObject)\w*\s*\(/i
  },
  {
    confidence: "LOW",
    category: "FILE_WRITE",
    reason:
      "Local filesystem mutation detected.",
    pattern:
      /\b(writeFile|appendFile|unlink|rename|rm)\s*\(/i
  },
  {
    confidence: "MEDIUM",
    category: "ACCOUNT",
    reason:
      "Account/user mutation operation detected.",
    pattern:
      /\b(createUser|deleteUser|disableUser|enableUser|updateUser|inviteUser)\w*\s*\(/i
  },
  {
    confidence: "MEDIUM",
    category: "PUBLISH",
    reason:
      "Publish/deploy/external creation operation detected.",
    pattern:
      /\b(publishPost|publishArticle|createIssue|createTicket|deployService|createResource)\w*\s*\(|\boctokit\.issues\.create\s*\(/i
  }
];

function shouldSkipFile(
  filePath: string
): boolean {

  const base =
    path.basename(filePath).toLowerCase();

  const ext =
    path.extname(filePath).toLowerCase();

  return (
    sensitiveNames.has(base) ||
    sensitiveExtensions.has(ext)
  );
}

function detectFunctionName(
  lines: string[],
  lineIndex: number
): string | undefined {

  const start =
    Math.max(0, lineIndex - 14);

  for (
    let i = lineIndex;
    i >= start;
    i--
  ) {
    const line = lines[i] ?? "";

    const matches = [
      line.match(
        /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/
      ),
      line.match(
        /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/
      ),
      line.match(
        /\b(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/
      ),
      line.match(
        /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
      )
    ];

    const reservedWords =
      new Set([
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "with"
      ]);

    for (const match of matches) {
      if (
        match?.[1] &&
        !reservedWords.has(
          match[1].toLowerCase()
        )
      ) {
        return match[1];
      }
    }
  }

  return undefined;
}

export async function detectProjectMetadata(
  root: string
): Promise<{
  languages: string[];
  tooling: string[];
}> {

  const languages =
    new Set<string>();

  const tooling =
    new Set<string>();

  try {
    const packagePath =
      path.join(root, "package.json");

    const raw =
      await fs.readFile(
        packagePath,
        "utf8"
      );

    const pkg =
      JSON.parse(
        raw.replace(/^\uFEFF/, "")
      ) as {
        dependencies?: Record<
          string,
          string
        >;
        devDependencies?: Record<
          string,
          string
        >;
      };

    languages.add(
      "JavaScript / TypeScript"
    );

    const dependencies = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {})
    };

    const dependencyNames =
      Object.keys(dependencies);

    const knownTooling:
      Array<[string, string]> = [
        ["openai", "OpenAI"],
        [
          "@anthropic-ai/sdk",
          "Anthropic"
        ],
        [
          "@openai/agents",
          "OpenAI Agents SDK"
        ],
        [
          "@modelcontextprotocol/sdk",
          "MCP"
        ],
        ["langchain", "LangChain"],
        ["@langchain/core", "LangChain"],
        ["ai", "Vercel AI SDK"],
        ["express", "Express"],
        ["fastify", "Fastify"],
        ["next", "Next.js"]
      ];

    for (
      const [dependency, label]
      of knownTooling
    ) {
      if (
        dependencyNames.includes(
          dependency
        )
      ) {
        tooling.add(label);
      }
    }

  } catch {
    // package.json is optional
  }

  for (
    const metadataName
    of [
      "requirements.txt",
      "pyproject.toml"
    ]
  ) {
    try {
      const raw =
        (
          await fs.readFile(
            path.join(
              root,
              metadataName
            ),
            "utf8"
          )
        ).toLowerCase();

      languages.add("Python");

      const pythonTools:
        Array<[string, string]> = [
          ["openai", "OpenAI"],
          ["anthropic", "Anthropic"],
          ["langchain", "LangChain"],
          ["crewai", "CrewAI"],
          ["autogen", "AutoGen"],
          ["fastapi", "FastAPI"]
        ];

      for (
        const [needle, label]
        of pythonTools
      ) {
        if (raw.includes(needle)) {
          tooling.add(label);
        }
      }

    } catch {
      // Python metadata is optional
    }
  }

  return {
    languages:
      [...languages],
    tooling:
      [...tooling]
  };
}

export async function collectSourceFiles(
  root: string
): Promise<string[]> {

  const files: string[] = [];

  const maxFiles = 5000;

  async function walk(
    current: string
  ): Promise<void> {

    if (
      files.length >= maxFiles
    ) {
      return;
    }

    let entries;

    try {
      entries =
        await fs.readdir(
          current,
          {
            withFileTypes: true
          }
        );
    } catch {
      return;
    }

    for (const entry of entries) {

      if (
        files.length >= maxFiles
      ) {
        break;
      }

      if (
        entry.isSymbolicLink()
      ) {
        continue;
      }

      const full =
        path.join(
          current,
          entry.name
        );

      if (entry.isDirectory()) {

        if (
          ignoredDirectories.has(
            entry.name
          )
        ) {
          continue;
        }

        await walk(full);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (
        shouldSkipFile(full)
      ) {
        continue;
      }

      const ext =
        path.extname(
          entry.name
        ).toLowerCase();

      if (
        !sourceExtensions.has(ext)
      ) {
        continue;
      }

      try {
        const stat =
          await fs.stat(full);

        if (
          stat.size >
          1_500_000
        ) {
          continue;
        }
      } catch {
        continue;
      }

      files.push(full);
    }
  }

  await walk(root);

  return files;
}

function isCommentOnlyLine(
  line: string
): boolean {

  const value =
    line.trim();

  return (
    value.startsWith("//") ||
    value.startsWith("#") ||
    value.startsWith("/*") ||
    value.startsWith("*")
  );
}

function isInsideQuotedString(
  line: string,
  index: number
): boolean {

  let quote:
    "'" | '"' | "`" | null =
      null;

  let escaped = false;

  for (
    let i = 0;
    i < index;
    i++
  ) {
    const char =
      line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (
      quote !== null &&
      char === "\\"
    ) {
      escaped = true;
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      quote = char;
    }
  }

  return quote !== null;
}

function isInFunctionDeclaration(
  line: string,
  index: number
): boolean {

  /*
   * A multiline declaration such as:
   *
   * export async function createOrder(
   *   ...
   * ) {
   *
   * has no opening brace on the line containing
   * createOrder(. Detect the explicit `function`
   * keyword before falling back to the existing
   * same-line brace logic.
   */
  const beforeMatch =
    line.slice(
      0,
      index
    );

  if (
    /\bfunction\s*\*?\s*$/i.test(
      beforeMatch
    )
  ) {
    return true;
  }

  const brace =
    line.indexOf("{");

  if (
    brace < 0 ||
    index > brace
  ) {
    return false;
  }

  const beforeBrace =
    line.slice(
      0,
      brace + 1
    );

  return (
    /\b(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(
      beforeBrace
    )
  );
}

function escapeRegex(
  value: string
): string {

  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

export async function scanFile(
  root: string,
  filePath: string
): Promise<Finding[]> {

  let text: string;

  try {
    text =
      await fs.readFile(
        filePath,
        "utf8"
      );
  } catch {
    return [];
  }

  const lines =
    text.split(/\r?\n/);

  const findings: Finding[] = [];

  const seen =
    new Set<string>();

  const httpAliases =
    new Set<string>();

  for (
    const aliasMatch
    of text.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*axios\b/g
    )
  ) {
    if (aliasMatch[1]) {
      httpAliases.add(
        aliasMatch[1]
      );
    }
  }

  for (
    const importMatch
    of text.matchAll(
      /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']axios["']/g
    )
  ) {
    const name =
      importMatch[1];

    if (
      name &&
      name !== "axios"
    ) {
      httpAliases.add(name);
    }
  }

  const activeRules:
    Rule[] = [
      ...rules
    ];

  if (
    httpAliases.size > 0
  ) {
    const aliases =
      [...httpAliases]
        .map(escapeRegex)
        .join("|");

    activeRules.push({
      confidence: "HIGH",
      category: "HTTP_DELETE",
      reason:
        "Outbound HTTP DELETE operation detected through an HTTP client alias.",
      pattern:
        new RegExp(
          `\\b(?:${aliases})\\.delete\\s*\\(`,
          "i"
        )
    });

    activeRules.push({
      confidence: "MEDIUM",
      category: "HTTP_WRITE",
      reason:
        "Outbound HTTP POST/PUT/PATCH operation detected through an HTTP client alias.",
      pattern:
        new RegExp(
          `\\b(?:${aliases})\\.(?:post|put|patch)\\s*\\(`,
          "i"
        )
    });
  }

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const windowText =
      lines
        .slice(
          i,
          Math.min(
            lines.length,
            i + 4
          )
        )
        .join("\n");

    for (const rule of activeRules) {

      const match =
        windowText.match(
          rule.pattern
        );

      if (
        !match ||
        match.index === undefined
      ) {
        continue;
      }

      const linesBeforeMatch =
        windowText
          .slice(
            0,
            match.index
          )
          .split("\n")
          .length - 1;

      const matchedLineIndex =
        i + linesBeforeMatch;

      const matchedSourceLine =
        lines[
          matchedLineIndex
        ] ?? "";

      const beforeMatch =
        windowText.slice(
          0,
          match.index
        );

      const lastLineBreak =
        beforeMatch.lastIndexOf(
          "\n"
        );

      const matchedColumn =
        match.index -
        (
          lastLineBreak + 1
        );

      if (
        isCommentOnlyLine(
          matchedSourceLine
        ) ||
        isInsideQuotedString(
          matchedSourceLine,
          matchedColumn
        ) ||
        isInFunctionDeclaration(
          matchedSourceLine,
          matchedColumn
        )
      ) {
        continue;
      }

      const knownHttpMutation =
        /\b(?:axios|got|superagent)\.(?:post|put|patch|delete)\s*\(/i
          .test(
            matchedSourceLine
          );

      if (
        rule.category ===
          "DATABASE" &&
        rule.confidence ===
          "MEDIUM" &&
        knownHttpMutation
      ) {
        continue;
      }

      const key =
        `${matchedLineIndex}:${rule.category}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      findings.push({
        file:
          path.relative(
            root,
            filePath
          ) ||
          path.basename(
            filePath
          ),
        line:
          matchedLineIndex + 1,
        functionName:
          detectFunctionName(
            lines,
            matchedLineIndex
          ),
        confidence:
          rule.confidence,
        category:
          rule.category,
        reason:
          rule.reason
      });
    }
  }

  return findings;
}

function confidenceRank(
  value: Confidence
): number {

  switch (value) {
    case "HIGH":
      return 0;

    case "MEDIUM":
      return 1;

    default:
      return 2;
  }
}

function printFindings(
  findings: Finding[]
): void {

  if (
    findings.length === 0
  ) {
    console.log("");
    console.log(
      "No obvious consequential operations were detected."
    );
    console.log("");
    console.log(
      "This does not prove the project has no side effects."
    );
    return;
  }

  const sorted =
    [...findings].sort(
      (a, b) =>
        confidenceRank(
          a.confidence
        ) -
          confidenceRank(
            b.confidence
          ) ||
        a.file.localeCompare(
          b.file
        ) ||
        a.line - b.line
    );

  const visible =
    sorted.slice(0, 60);

  let current:
    Confidence | undefined;

  for (
    const finding
    of visible
  ) {
    if (
      finding.confidence !==
      current
    ) {
      current =
        finding.confidence;

      console.log("");
      console.log(
        current
      );
      console.log(
        "-".repeat(
          current.length
        )
      );
    }

    const location =
      `${finding.file}:${finding.line}`;

    const fn =
      finding.functionName
        ? `  ${finding.functionName}()`
        : "";

    console.log(
      `${location}${fn}`
    );

    console.log(
      `  ${finding.category}: ${finding.reason}`
    );
  }

  if (
    sorted.length >
    visible.length
  ) {
    console.log("");
    console.log(
      `... ${sorted.length - visible.length} additional findings not shown.`
    );
  }
}

function parsePositiveNumber(
  value: string
): number | undefined {

  const normalized =
    value
      .trim()
      .replaceAll(",", "");

  if (!normalized) {
    return undefined;
  }

  const parsed =
    Number(normalized);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return undefined;
  }

  return parsed;
}

function planForUsage(
  monthly: number
): string {

  if (monthly <= 100_000) {
    return "Pro capacity (100,000/month)";
  }

  if (monthly <= 500_000) {
    return "Startup capacity (500,000/month)";
  }

  if (monthly <= 2_000_000) {
    return "Scale capacity (2,000,000/month)";
  }

  return "Higher/custom capacity";
}

async function runEstimate(): Promise<void> {

  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return;
  }

  const rl =
    readline.createInterface({
      input,
      output
    });

  try {
    console.log("");
    console.log(
      "VALUE ESTIMATE"
    );
    console.log(
      "--------------"
    );

    const answer =
      (
        await rl.question(
          "Estimate expected Once usage/value? [Y/n] "
        )
      )
        .trim()
        .toLowerCase();

    if (
      answer === "n" ||
      answer === "no"
    ) {
      return;
    }

    const dailyInput =
      await rl.question(
        "Expected UNIQUE protected operations per day: "
      );

    const daily =
      parsePositiveNumber(
        dailyInput
      );

    if (
      daily === undefined
    ) {
      console.log("");
      console.log(
        "Usage estimate skipped."
      );
      return;
    }

    const monthly =
      Math.round(
        daily * 30
      );

    console.log("");
    console.log(
      "ESTIMATED ONCE USAGE"
    );
    console.log(
      "--------------------"
    );
    console.log(
      `[CUSTOMER INPUT] ${daily.toLocaleString()} protected operations/day`
    );
    console.log(
      `[CALCULATED] ${monthly.toLocaleString()} protected operations/month`
    );
    console.log(
      `[CALCULATED] Capacity fit: ${planForUsage(monthly)}`
    );
    console.log(
      "Retries of the same operation ID are not included as new unique operations."
    );

    const incidentsInput =
      await rl.question(
        "Estimated duplicate incidents/month today (Enter to skip): "
      );

    const incidents =
      parsePositiveNumber(
        incidentsInput
      );

    if (
      incidents === undefined
    ) {
      console.log("");
      console.log(
        "Financial estimate skipped."
      );
      return;
    }

    const costInput =
      await rl.question(
        "Average cost of one duplicate incident: "
      );

    const cost =
      parsePositiveNumber(
        costInput
      );

    if (
      cost === undefined
    ) {
      console.log("");
      console.log(
        "Financial estimate skipped."
      );
      return;
    }

    const currencyInput =
      (
        await rl.question(
          "Currency symbol/code [Â£]: "
        )
      ).trim();

    const currency =
      currencyInput || "Â£";

    const monthlyExposure =
      incidents * cost;

    const annualExposure =
      monthlyExposure * 12;

    console.log("");
    console.log(
      "VALUE SCENARIO"
    );
    console.log(
      "--------------"
    );
    console.log(
      `[CUSTOMER INPUT] ${incidents} duplicate incidents/month`
    );
    console.log(
      `[CUSTOMER INPUT] ${currency}${cost.toLocaleString()} average cost/incident`
    );
    console.log(
      `[CALCULATED] Potential duplicate-loss exposure: ${currency}${monthlyExposure.toLocaleString()}/month`
    );
    console.log(
      `[CALCULATED] Potential duplicate-loss exposure: ${currency}${annualExposure.toLocaleString()}/year`
    );

    console.log("");
    console.log(
      "These are scenario estimates, not measured savings."
    );
    console.log(
      "Once Observe can later replace assumptions with measured behaviour."
    );

  } finally {
    rl.close();
  }
}

export async function runScan(
  requestedPath: string,
  estimate = true
): Promise<void> {

  const root =
    path.resolve(
      requestedPath
    );

  const stat =
    await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(
      "Scan target must be a directory."
    );
  }

  console.log("");
  console.log(
    "Once Safety Scan"
  );
  console.log(
    "----------------"
  );
  console.log(
    `Directory: ${root}`
  );
  console.log(
    "Mode: local + read-only"
  );
  console.log(
    "Source uploaded: no"
  );
  console.log(
    "Code changes: none"
  );

  const metadata =
    await detectProjectMetadata(
      root
    );

  const files =
    await collectSourceFiles(
      root
    );

  const findings: Finding[] =
    [];

  for (const file of files) {
    findings.push(
      ...await scanFile(
        root,
        file
      )
    );
  }

  console.log("");
  console.log(
    `Files scanned: ${files.length}`
  );

  if (
    metadata.languages.length
  ) {
    console.log(
      `Project: ${metadata.languages.join(", ")}`
    );
  }

  if (
    metadata.tooling.length
  ) {
    console.log(
      `Detected tooling: ${metadata.tooling.join(", ")}`
    );
  }

  const high =
    findings.filter(
      finding =>
        finding.confidence ===
        "HIGH"
    ).length;

  const medium =
    findings.filter(
      finding =>
        finding.confidence ===
        "MEDIUM"
    ).length;

  const low =
    findings.filter(
      finding =>
        finding.confidence ===
        "LOW"
    ).length;

  console.log("");
  console.log(
    "DETECTED"
  );
  console.log(
    "--------"
  );
  console.log(
    `Consequential-operation candidates: ${findings.length}`
  );
  console.log(
    `HIGH ${high}   MEDIUM ${medium}   LOW ${low}`
  );

  printFindings(
    findings
  );

  console.log("");
  console.log(
    "Detection is heuristic. Review findings before protecting or changing code."
  );

  if (
    estimate &&
    findings.length > 0
  ) {
    await runEstimate();
  }
}
