# Prompts used to build TradeLens

These are pasted as-is, including the attempts that didn't work. The build went through two rounds.

## Round 1: Codex (ChatGPT), first build (did not ship)

The first version was built with Codex and deployed to `tradelens-review-1026.vercel.app`. Its prompts are in the original Codex conversation.

> **TODO before submitting:** paste the Codex prompts here verbatim. In ChatGPT, open the Codex task and copy each message you sent, in order.

### Why round 1 didn't work
I tested the Codex build against the brief and its own example file:

- **Wrong top habit.** It surfaced three findings in a fixed order, not by rupee cost. Its single "next step" was to review fees (₹2,100), while BANKNIFTY had cost ₹9,100.
- **Flagged a habit that made money.** It flagged "re-entries after a loss" as a problem, but those re-entries were profitable (+₹650).
- **Wrong time-of-day answer.** Asked "What time of day am I worst?", it answered with the *strongest* hour, which was −₹1,390.
- **Couldn't read order history.** It needed closed trades with P&L already worked out, so it couldn't do what the brief asks: start from order history.
- **Missing artifacts.** There was no one-pager and no evals, and its source code was never kept (Vercel only had the built output).

Those findings became the requirements for round 2.

## Round 2: Claude Code, rebuilt from scratch

### Prompts I gave Claude Code (verbatim)

**1. Audit the first build**
```
I have this project: https://tradelens-review-1026.vercel.app/
Can you access this project and then do an analysis. This project should be suitable for this: "C:\Users\anuj_\Downloads\Tradelens". It should match all the constraints and requirements in teh Nubra Product Intern Assignment PDF. Also, it should behave appropriately to the Example data in the directory. Also check that the project has all the requirements mentioned in the JD.
This project was made using Codex (ChatGPT), but I believe you can do better. If you can access the chatgpt chat here it is: https://chatgpt.com/s/cx_6adf2f398f4c8191a6a2f609507312b8
```
*Result: the audit summarised above. The ChatGPT share link was blocked by a Cloudflare check, so the Codex prompts could not be read automatically.*

**2–4. Try to recover the Codex source (did not work)**
```
can you access the source code of this website
```
```
[screenshot of Vercel → Deployment → Source → Output tab]
I am inside the matrix (the vercel login), can you tell me where to download the entire source code from
```
```
[screenshot of Vercel → Source tab: assets/, index.html, favicon.svg, TradeLens-example.xlsx, vercel.json]
i am on the source tab, check in this screenshot:
```
*Result: a dead end. Codex had built the site itself and uploaded only the compiled output (`"framework": null, "buildCommand": null`), so there was no source to recover. I decided to rebuild from scratch.*

**5. Rebuild everything**
```
Okay, so scratch that, just do this: Create for me everything this project needs from scratch, all the artifacts (submissions), meeting all the requirements with fresh source code. Keep the source code local for now, we will be directly uploading it to vercel.
```

**6. Better sample data**
```
can you also generate a better/improved example dataset for this project, which meets all the JD and PDF requirements.
```

<!-- Add any later prompts (fixes, tweaks) here, in order. -->

### Prompts Claude Code wrote for its sub-agents (verbatim, in files)

Claude Code designed the analysis engine and wrote it itself. It then split the remaining work between two parallel sub-agents, each with a self-contained brief:

| Brief | What it built |
|---|---|
| [`prompts/brief-ui.md`](prompts/brief-ui.md) | The React interface: upload, column check, review page, commit-to-a-rule, export |
| [`prompts/brief-data-evals.md`](prompts/brief-data-evals.md) | The September 2026 sample dataset, the eval harness and fixtures, and unit tests |

## What I learned about prompting this
- **Point it at the evaluation criteria.** "Match the PDF, the JD and the example data" made the audit check against them instead of just describing the app.
- **Ask for evals before calling it done.** Deterministic checks plus an eval harness meant "good enough to ship" was measured, not guessed.
