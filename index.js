import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as core from "@actions/core";
import * as github from "@actions/github";

const execFileAsync = promisify(execFile);
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

async function getCommitsSince(tag) {
  const args = [
    "log",
    "--format=%H%x1f%s%x1f%an%x1e",
  ];
  if (tag) {
    args.push(`${tag}..HEAD`);
  } else {
    // Avoid an unbounded API lookup when a repository has no release baseline.
    args.push("--max-count=50", "HEAD");
  }

  const output = await runGit(args);

  return output
    .split(recordSeparator)
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, authorName] = record.split(fieldSeparator);
      return { sha, subject, authorName };
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

async function resolveCredit(octokit, owner, repo, commit) {
  // A token is optional; missing or unlinked GitHub accounts use the Git author.
  if (!octokit) {
    return commit.authorName;
  }

  try {
    const { repository } = await octokit.graphql(
      `query CommitAuthor($owner: String!, $repo: String!, $expression: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $expression) {
            ... on Commit {
              author {
                user {
                  login
                }
              }
            }
          }
        }
      }`,
      { owner, repo, expression: commit.sha },
    );
    const login = repository?.object?.author?.user?.login;
    return login ? `@${login}` : commit.authorName;
  } catch (graphqlError) {
    core.debug(
      `Could not resolve the GitHub author through GraphQL for ${commit.sha}; trying REST. ${graphqlError.message}`,
    );
  }

  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: commit.sha,
    });
    if (data.author?.login) {
      return `@${data.author.login}`;
    }
  } catch (error) {
    core.debug(
      `Could not resolve the GitHub author for ${commit.sha}; using the Git author name. ${error.message}`,
    );
  }

  return commit.authorName;
}

async function getCredits(commits, token) {
  const credits = new Map();
  if (commits.length === 0) {
    return credits;
  }

  const octokit = token ? github.getOctokit(token) : undefined;
  const { owner, repo } = github.context.repo;
  for (const commit of commits) {
    const credit = await resolveCredit(octokit, owner, repo, commit);
    credits.set(`${commit.language}\u0000${credit}`, { language: commit.language, credit });
  }
  return credits;
}

function formatCredits(credits, tag) {
  if (credits.length === 0) {
    return tag
      ? `No translator credits found since ${tag}.`
      : "No translator credits found in the most recent 50 commits.";
  }

  const entries = [...credits].sort(
    (left, right) =>
      left.language.localeCompare(right.language) || left.credit.localeCompare(right.credit),
  );
  return [
    " - More strings translated",
    ...entries.map(({ language, credit }) => `   - ${language} by ${credit}`),
  ].join("\n");
}

async function run() {
  try {
    const tagPattern = core.getInput("tagPattern") || "*";
    const commitPattern = createCommitPattern(core.getInput("commitPattern"));
    const baselineTag = await findBaselineTag(tagPattern);
    if (!baselineTag) {
      core.info(`No tags found matching ${tagPattern}; comparing the most recent 50 commits.`);
    }

    const commits = getMatchingCommits(await getCommitsSince(baselineTag), commitPattern);
    const credits = await getCredits(commits, core.getInput("token"));

    const output = formatCredits([...credits.values()], baselineTag);
    core.setOutput("credits", output);
    const rangeDescription = baselineTag ? `since ${baselineTag}` : "in the most recent 50 commits";
    core.info(`Generated ${credits.size} translator credit${credits.size === 1 ? "" : "s"} ${rangeDescription}.`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
