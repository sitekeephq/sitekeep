# Masking of personal data in AI prompts

What SiteKeep replaces before a prompt leaves the network, and what it does not. For the
[DPIA](DPIA_HELPER.md) and the transfer assessment of an AI provider ([subprocessors](SUBPROCESSORS.md)).

## Where the code is

The masker is in the core: `apps/server/src/privacy/redact.ts` (`Redactor`), with project members as
name entries from `apps/server/src/privacy/people.ts`. Modules get both through the SDK
(`Redactor`, `projectPeople`). The **AI module** is what uses them: it masks every prompt it sends to a
model outside the network, including Ollama `:cloud` models on a local address (and to local models
too with **Mask for the Local Model Too**). The
report builder of the Platform module uses the same SDK class. Community without modules sends no
prompts, so nothing is masked there.

Settings (Privacy Centre → Summary): **Mask for the Local Model Too** (off by default) and **Mask
Project Members' Names** (on by default). Details of the flow: [privacy](../features/PRIVACY.md#data-minimisation-in-ai).

## What is masked

| Data | Pattern | Placeholder |
|---|---|---|
| E-mail address | any address (`name@domain.tld`, Unicode letters allowed) | `[E-POSTA_1]` |
| Turkish phone number | `+90` / `0090` / `0` prefix and an area code 2xx–5xx, or a mobile number 5xx without prefix; spaces, dots, dashes and `(0xxx)` allowed | `[TELEFON_1]` |
| Turkish national ID (TC kimlik no) | 11 digits **with a valid checksum** | `[TCKN_1]` |
| Turkish IBAN | `TR` + 24 digits, with or without spaces | `[IBAN_1]` |
| Full names of project members | the names in the project's member list (two words or more), matched without regard to Turkish case | role and company, e.g. `[Proje Müdürü (Poyraz)]` |

The mapping lives in memory for one model call; placeholders in the answer are put back before the
same user sees it. The outbound log records how many items of each kind were masked, never the values.

## Limits

Masking is a data minimisation layer, **not anonymisation**: masked prompts remain personal data, and
sending them to a cloud provider is still a transfer ([AI providers](../features/AI_PROVIDERS.md#transfers-abroad-kvkk-and-gdpr)).
It does not catch:

- **Identifiers of other countries:** non-Turkish IBANs (e.g. `DE89 3704 …`), international phone
  numbers without a Turkish prefix or area code, national IDs and passport, tax, social security or
  licence numbers of any other country, Turkish tax numbers (VKN) and Turkish IDs with an invalid
  checksum;
- **names of people who are not project members** (people named in letters, minutes, file names) and
  single-word names;
- **indirect identifiers:** postal addresses, job titles ("the site chief of block C"), plate numbers,
  dates of birth, health information in incident reports;
- anything in **document text** quoted into a prompt beyond the patterns above (the same rules apply
  to it as to any other prompt text);
- prompts of the **AI task queue** read by an external client (planned);
- a local server or AI gateway that forwards prompts to a cloud service under a model name SiteKeep
  cannot recognise: such a prompt is not masked unless **Mask for the Local Model Too** is on
  ([AI providers](../features/AI_PROVIDERS.md#ollama-cloud-models-and-ai-gateways)).

So for projects with sensitive data, prefer a **local model** inside the network, or keep AI off.

## Planned

EU IBANs (ISO 13616 checksum), international phone numbers (E.164), and further national identifiers
(e.g. by the installation's country) can be added to `redact.ts`; each needs a checksum or a strict
pattern to keep false positives (drawing numbers, quantities) low. Issue #85 P2-6.
