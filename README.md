# Andromeda

**Ask anything, make anything. Each part goes to the AI model that's best at it.**

There are hundreds of strong AI models now. Each lab leads at something different, and the lead changes every few weeks. People shouldn't have to track that, set up tools, or pay for five subscriptions to get the best of each.

With Andromeda you just type. It sends each part of your request to the strongest model for that kind of work, and you can see which models worked on every answer. Nothing to install and no keys: sign in and you get free credits every day.

![Andromeda](docs/welcome.png)

## What it makes

- **Answers:** short questions go to one fast model; bigger ones go to a team: a lead plans the work and specialists from different labs research, reason, code and write it.
- **Videos and ads:** a director plans the shots, then image, video, voice (ElevenLabs) and music (Lyria) models make them, and Andromeda edits them into one video with captions.
- **Photos, music and voiceovers.**
- **Apps and games:** built, tested and running right in the chat.
- **Files:** real PowerPoint decks (with charts and speaker notes), Excel spreadsheets with working formulas, Word documents and PDFs.
- **Study:** mind maps, flashcards, quizzes that grade your answers, two-host podcasts and interactive simulations.

## Always looking things up

- A link in your message is opened and read.
- Name a library in a coding question and it pulls that library's current docs (Context7).
- Ask about something recent and it searches the web live.

## Andromeda Code

Open a folder on your computer or connect a GitHub repo, then ask for a change. Andromeda Code:

- finds and reads the files it needs and edits them precisely;
- looks up current docs and checks its own work, fixing what it broke;
- shows you a diff and, for websites, a live preview.

In a folder you can undo every change. On GitHub, nothing is committed until you click: commit, or open a pull request.

## How models are picked

Andromeda reads OpenRouter's live model list every time it starts and never hardcodes a model. For each kind of task it knows which labs lead, and from each lab it takes the newest version of that lab's flagship line. A new release is used the day it ships.

| Task | Labs, in order | Picked today |
|---|---|---|
| Code | Anthropic, OpenAI, Google, Moonshot, xAI… | Claude Opus 5.5 |
| Reasoning and maths | OpenAI, Google, Anthropic, xAI, DeepSeek… | GPT-6.1 Sol |
| Brainstorming | Anthropic, OpenAI, xAI, Google… | Claude Opus 5.5 |
| Writing | Anthropic, OpenAI, Google… | Claude Opus 5.5 |
| Research and news | Perplexity (live web search), Google… | Sonar Pro Search |
| Images you send | Google, OpenAI, Anthropic… | Gemini 3.1 Pro |
| Quick questions | Fast tiers from Google, OpenAI, Anthropic | Gemini 3.8 Flash |

If a model is busy, the next one in line takes over.

## Credits

- Everyone gets free credits that come back every day.
- More can be bought with QRIS (and card, once it's set up).
- Andromeda only ever shows credits, never token counts.

The site runs through a small credits server on Cloudflare (`server/`) that holds the OpenRouter key, so no one using the site ever needs or sees a key. To set it up, double-click `server/SET UP SERVER.bat`.

## License

MIT. See [LICENSE](LICENSE).
