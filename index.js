import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as core from "@actions/core";

const execFileAsync = promisify(execFile);
const githubApiVersion = "2026-03-10";
const githubApiVersionHeaders = {
  "X-GitHub-Api-Version": githubApiVersion,
};
// These control characters safely delimit Git fields and records in one command.
const fieldSeparator = "\u001f";
const recordSeparator = "\u001e";

async function runGit(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
  });
  return stdout;
}

async function findBaselineTag(tagPattern) {
  const matchingTags = await runGit(["tag", "--merged", "HEAD", "--list", tagPattern]);
  if (!matchingTags.trim()) {
    return undefined;
  }

  return (await runGit([
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    tagPattern,
    "HEAD",
  ])).trim();
}

function createCommitPattern(source) {
  let commitPattern;
  try {
    commitPattern = new RegExp(source);
  } catch (error) {
    throw new Error(`commitPattern is not a valid JavaScript regular expression: ${error.message}`);
  }

  const probe = new RegExp(`${source}|`).exec("");
  if (!Object.hasOwn(probe?.groups || {}, "language")) {
    throw new Error('commitPattern must provide a named "language" capture group.');
  }

  return commitPattern;
}

function getBlacklistedUsers(source) {
  return new Set(
    source
      .split(",")
      .map((username) => username.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}

async function getCommitsSince(tag) {
  const args = [
    "log",
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1e",
  ];
  if (tag) {
    args.push(`${tag}..HEAD`);
  } else {
    // Avoid an unbounded API lookup when a repository has no release baseline.
    args.push("--max-count=100", "HEAD");
  }

  const output = await runGit(args);

  return output
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, authorName, authorEmail = ""] = record.split(fieldSeparator);
      return { sha, subject, authorName, authorEmail };
    });
}

function getMatchingCommits(commits, commitPattern) {
  const matchingCommits = [];
  for (const commit of commits) {
    const match = commitPattern.exec(commit.subject);
    if (!match) {
      continue;
    }

    const language = match.groups?.language?.trim();
    if (!language) {
      throw new Error(
        `commitPattern matched commit ${commit.sha}, but did not capture a non-empty language.`,
      );
    }
    matchingCommits.push({ ...commit, language });
  }
  return matchingCommits;
}

async function getLoginsByEmail(commits) {
  const representativeCommits = new Map();
  for (const commit of commits) {
    if (commit.authorEmail && !representativeCommits.has(commit.authorEmail)) {
      representativeCommits.set(commit.authorEmail, commit);
    }
  }

  const loginsByEmail = new Map();
  const lookupFailures = new Map();
  let unlinkedAuthors = 0;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must be set to resolve GitHub usernames.");
  }

  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  for (const [email, commit] of representativeCommits) {
    try {
      const response = await fetch(
        `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${commit.sha}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "get-translator-credits",
            ...githubApiVersionHeaders,
          },
        },
      );
      if (response.ok) {
        const data = await response.json();
        if (data.author?.login) {
          loginsByEmail.set(email, data.author.login);
        } else {
          unlinkedAuthors++;
        }
      } else {
        const reason = `HTTP ${response.status}`;
        lookupFailures.set(reason, (lookupFailures.get(reason) || 0) + 1);
      }
    } catch (error) {
      const reason = "network error";
      lookupFailures.set(reason, (lookupFailures.get(reason) || 0) + 1);
    }
  }

  const details = [];
  if (unlinkedAuthors > 0) {
    details.push(`${unlinkedAuthors} without a linked GitHub user`);
  }
  for (const [reason, count] of lookupFailures) {
    details.push(`${count} ${reason}`);
  }
  core.info(
    `Resolved ${loginsByEmail.size} GitHub username${loginsByEmail.size === 1 ? "" : "s"} ` +
      `from ${representativeCommits.size} distinct author email${representativeCommits.size === 1 ? "" : "s"}` +
      (details.length > 0 ? ` (${details.join(", ")})` : ""),
  );

  return loginsByEmail;
}

async function getCredits(commits, blacklistedUsers) {
  const credits = new Map();
  if (commits.length === 0) {
    return credits;
  }

  const loginsByEmail = await getLoginsByEmail(commits);
  let excludedCredits = 0;
  for (const commit of commits) {
    const login = loginsByEmail.get(commit.authorEmail);
    if (login && blacklistedUsers.has(login.toLowerCase())) {
      excludedCredits++;
      core.info(
        `Excluded @${login}: ${commit.subject} | author: ${commit.authorName} | SHA: ${commit.sha}`,
      );
      continue;
    }
    const credit = login ? `@${login}` : commit.authorName;
    credits.set(`${commit.language}\u0000${credit}`, { language: commit.language, credit });
  }
  if (excludedCredits > 0) {
    core.info(`Excluded ${excludedCredits} credit${excludedCredits === 1 ? "" : "s"} for blacklisted GitHub users.`);
  }
  return credits;
}

function formatCredits(credits, tag) {
  if (credits.length === 0) {
    return tag
      ? `No translator credits found since ${tag}.`
      : "No translator credits found in the most recent 100 commits.";
  }

  const creditsByLanguage = new Map();
  for (const credit of credits) {
    const languageCredits = creditsByLanguage.get(credit.language) || [];
    languageCredits.push(credit.credit);
    creditsByLanguage.set(credit.language, languageCredits);
  }

  const entries = [...creditsByLanguage]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([language, languageCredits]) => {
      const usernames = languageCredits
        .filter((credit) => credit.startsWith("@"))
        .sort((left, right) => left.localeCompare(right));
      const names = languageCredits
        .filter((credit) => !credit.startsWith("@"))
        .sort((left, right) => left.localeCompare(right));
      const contributors = [usernames.join(" "), names.join(", ")].filter(Boolean).join("; ");
      return `   - ${language} by ${contributors}`;
    });
  return [
    " - More strings translated",
    ...entries,
  ].join("\n");
}

async function run() {
  try {
    const tagPattern = core.getInput("tagPattern") || "*";
    const commitPattern = createCommitPattern(core.getInput("commitPattern"));
    const blacklistedUsers = getBlacklistedUsers(core.getInput("blacklistedUsers"));
    const baselineTag = await findBaselineTag(tagPattern);
    if (!baselineTag) {
      core.info(`No tags found matching ${tagPattern}; comparing the most recent 100 commits.`);
    }

    const commits = getMatchingCommits(await getCommitsSince(baselineTag), commitPattern);
    const credits = await getCredits(commits, blacklistedUsers);

    const output = formatCredits([...credits.values()], baselineTag);
    core.setOutput("credits", output);
    const rangeDescription = baselineTag ? `since ${baselineTag}` : "in the most recent 100 commits";
    core.info(`Generated ${credits.size} translator credit${credits.size === 1 ? "" : "s"} ${rangeDescription}.`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
