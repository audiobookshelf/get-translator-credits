# Get translator credits

Build a Markdown release-note block that credits Weblate translators whose commits were added since the previous release tag.

The action examines the checked-out Git history. It uses the nearest reachable tag matching `tagPattern` as the baseline. The documented workflow runs only when a commit pushed to `master` has `weblate` in its message; use its output before creating a new release tag.

## Usage

For commits pushed to `master` whose message contains `weblate`, check out complete history and tags, then use the `credits` output in your release-note workflow or another subsequent step.

```yaml
name: Prepare release notes

on:
  push:
    branches:
      - master

jobs:
  release-notes:
    if: contains(github.event.head_commit.message, 'weblate')
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - id: translator-credits
        uses: audiobookshelf/get-translator-credits@v1

      - name: Show translator credits
        run: |
          printf '%s\n' "${{ steps.translator-credits.outputs.credits }}"
```

`fetch-depth: 0` is required so the action can find the prior matching release tag and its commits. Generate credits before creating a new release tag; if the action runs on an already tagged release commit, that tag becomes the baseline and no later commits are in the range.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `tagPattern` | No | `*` | Glob pattern for release tags. The nearest reachable matching tag is the baseline. |
| `commitPattern` | No | `^(?:Translated|Added translation) using Weblate \\((?<language>.+)\\)$` | JavaScript regular expression matched against a commit subject. It must include a named `language` capture group. |

## Output

| Output | Description |
| --- | --- |
| `credits` | A ready-to-insert Markdown translator-credit block. |

Matching commits derive their language from `commitPattern`. For each distinct Git author email, the action uses a representative commit to look up the linked GitHub login through the public REST API; it credits that login as `@username` when available and otherwise credits the raw Git author name. Repeated language/credit pairs are removed and grouped by language. Languages are sorted alphabetically; within each line, sorted GitHub usernames appear first, separated by spaces, followed by raw author names after a semicolon. Multiple raw author names are separated by commas.

For matching commits, `credits` follows this format:

```md
 - More strings translated
   - English by @nichwall @advplyr; John Smith
   - Chinese (Simplified Han script) by @advplyr
```

If there are no matching commits, the output is `No translator credits found since <tag>.` If no reachable tag matches `tagPattern`, the action logs that fact and compares only the most recent 50 commits instead.

## License

This GitHub Action is licensed under the [MIT License](LICENSE).
