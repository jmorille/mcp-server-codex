# mcp-server-codex

Serveur **MCP (Model Context Protocol)** en TypeScript pour piloter le **CLI Codex** localement : lancer des sessions d'agent, les reprendre, les bifurquer, faire des revues de code, appliquer des diffs et générer des images — le tout depuis n'importe quel client MCP (Claude Code, Claude Desktop, Codex lui-même…).

> Le code, les identifiants et les messages d'erreur sont en anglais : ils sont lus par des agents. La documentation est en français.

## Ce que ça fait

Le CLI Codex est conçu pour un humain devant un terminal. Ce serveur le rend pilotable par un agent :

- Il force `--json` partout et parse le flux JSONL en résultats structurés.
- Il gère les runs longs sans faire tomber l'appel d'outil (voir *Exécution hybride*).
- Il restreint ce que Codex peut toucher sur le disque.
- Il expose la génération d'images, que Codex n'offre pas comme service appelable.

## Prérequis

| Outil | Rôle | Installation Windows |
|---|---|---|
| **Codex CLI** ≥ 0.154 | le binaire piloté | `npm i -g @openai/codex` *(recommandé)* ou `winget install OpenAI.Codex` |
| **Node.js** ≥ 22.0 | exécution du serveur (≥ 22.18 pour développer) | `winget install OpenJS.NodeJS` (fournit aussi `npm`) |
| **git** | `codex exec` refuse de tourner hors dépôt ; requis par les cibles de revue | `winget install Git.Git` |

Vous devez être authentifié côté Codex (`codex login`). Le serveur n'a besoin d'**aucune** clé API, y compris pour les images.

> ⚠️ La version de Codex publiée sur winget est en retard sur celle de npm. Ce serveur est écrit contre le comportement de la **0.154** (voir *Notes d'implémentation*). Préférez npm. Un Codex installé par npm n'apparaît pas dans `winget list` : évitez de mélanger les deux voies, sous peine d'avoir deux binaires concurrents dans le `PATH`. En cas de doute, pointez `CODEX_BIN` sur le bon exécutable.

## Installation

```bash
npm install
npm run build
```

## Configuration client

### Claude Code

```bash
claude mcp add codex -- node C:/chemin/vers/mcp-server-codex/dist/index.js
```

### Claude Desktop / configuration JSON générique

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["C:/chemin/vers/mcp-server-codex/dist/index.js"],
      "env": {
        "CODEX_MCP_ALLOWED_ROOTS": "C:/projets/mon-app",
        "CODEX_MCP_DEFAULT_SANDBOX": "workspace-write"
      }
    }
  }
}
```

Le serveur parle **stdio**. Tous ses diagnostics vont sur `stderr` : `stdout` transporte le protocole et écrire dedans corromprait la session.

### Ce que le client voit à l'initialisation

Le serveur publie une **description** — ce qu'il pilote et à quoi ça sert, lu par l'humain qui décide de l'installer — et des **instructions** lues par l'agent appelant, qui doit arbitrer entre faire le travail lui-même et le déléguer.

> Drives the Codex CLI locally, so an agent can hand a coding task to a second autonomous agent instead of doing it turn by turn. Codex is at its best on work that is long, mechanical and verifiable: a refactor across many files, making a failing suite pass, a code review, tracing a bug through an unfamiliar codebase. […]

Les instructions couvrent ce que le schéma des outils ne dit pas : **quand** déléguer à Codex plutôt que d'éditer soi-même, donner un objectif vérifiable plutôt qu'une procédure, le fait qu'un dépassement de délai rende un `job_id` au lieu d'échouer, la reprise par `thread_id`, les deux garde-fous qui rejettent un appel avant tout lancement, et le pont.

Le pont publie les siennes, lues par Codex : à quel moment poser une question vaut mieux que deviner, et qu'une question expirée n'est pas une impasse.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `CODEX_BIN` | `codex` | Chemin ou nom du binaire Codex. |
| `CODEX_HOME` | `~/.codex` | Racine Codex : sessions et images générées y sont lues. |
| `CODEX_MCP_ALLOWED_ROOTS` | cwd du serveur | Répertoires autorisés, séparés par `;` (Windows) ou `:`. **Liste exhaustive** : la définir remplace le défaut, elle ne s'y ajoute pas. |
| `CODEX_MCP_ALLOW_DANGEROUS` | `0` | À `1`, débloque `danger-full-access` et le contournement des approbations. |
| `CODEX_MCP_DEFAULT_SANDBOX` | `workspace-write` | Sandbox par défaut : `read-only`, `workspace-write` ou `danger-full-access`. |
| `CODEX_MCP_DEFAULT_TIMEOUT_SECONDS` | `120` | Attente avant bascule en arrière-plan. `0` = toujours en arrière-plan. |
| `CODEX_MCP_MAX_EVENTS` | `2000` | Taille du tampon d'événements par job. |
| `CODEX_MCP_JOB_TTL_SECONDS` | `1800` | Durée de consultation d'un job terminé. |
| `CODEX_MCP_BRIDGE_DIR` | `$CODEX_HOME/mcp-bridge` | Boîte aux lettres partagée avec les processus pont. |
| `CODEX_MCP_BRIDGE_TIMEOUT_SECONDS` | `90` | Attente d'un `ask_claude` côté Codex avant de rendre un `question_id`. |
| `CODEX_MCP_BRIDGE_COMMAND` | Node courant | Exécutable que Codex lance pour le pont. |
| `CODEX_MCP_BRIDGE_ENTRY` | `dist/bridge/index.js` | Script du pont passé à cet exécutable. |
| `CODEX_MCP_IMAGE_PRESETS` | *(aucun)* | Fichier JSON de presets d'image nommés. C'est par là qu'une instance se spécialise. |

Une valeur invalide fait **échouer le démarrage** (code 78) plutôt que de retomber silencieusement sur un défaut : une faute de frappe ne doit pas devenir une politique de sécurité différente de celle demandée.

## Exécution hybride

Un run Codex dure de quelques secondes à plusieurs dizaines de minutes, alors que les clients MCP coupent les appels d'outil bien avant. Chaque outil d'exécution fait donc la course contre son propre `timeout_seconds` :

- **il finit à temps** → résultat complet en un aller-retour ;
- **le délai expire** → le processus **continue**, l'appel rend un `job_id` immédiatement.

Le délai n'annule jamais le run : perdre dix minutes de travail du modèle à cause d'une échéance arbitraire du client est précisément ce que ce design évite.

```
codex_exec { prompt: "…", timeout_seconds: 60 }
  └─ dépassement → { job_id: "job-3-a1b2", mode: "background", thread_id: "…" }
       ├─ codex_job_status { job_id }
       ├─ codex_job_logs   { job_id, since: 42 }   ← pagination par curseur
       └─ codex_job_cancel { job_id }              ← SIGTERM puis SIGKILL
```

Les jobs vivent le temps de la session MCP.

## Outils

| Outil | Rôle |
|---|---|
| `codex_exec` | Nouvelle session Codex sur un prompt. Rend le message final, les commandes exécutées et un `thread_id`. |
| `codex_resume` | Reprend une session avec tout son historique (`session_id` ou `last: true`). |
| `codex_fork` | Bifurque une session existante, l'originale reste intacte. |
| `codex_review` | Revue de code : `uncommitted` (défaut), `base`, ou `commit`. |
| `codex_apply` | Applique le dernier diff d'une tâche Codex (`git apply`). |
| `codex_list_sessions` | Liste les sessions enregistrées. Lecture disque, aucun processus lancé. |
| `codex_generate_image` | Génère une image et l'écrit sur disque. |
| `codex_job_status` | État d'un run passé en arrière-plan. |
| `codex_job_logs` | Événements JSONL paginés d'un job, filtrables par type. |
| `codex_job_cancel` | Arrête un run en cours. |
| `codex_inbox` | Relève ce que Codex a envoyé : questions bloquantes, constats, alertes. |
| `codex_reply` | Répond à une question de Codex ; le run en attente repart aussitôt. |
| `codex_tell` | Envoie à Codex un message qu'il n'a pas demandé — correction, changement de cap, arrêt. |
| `codex_preset_list` | Détail complet des presets d'image de l'instance, et le fichier d'où ils viennent. |
| `codex_preset_reload` | Relit le fichier de presets depuis le disque, sans redémarrage. |
| `codex_preset_set` | Ajoute ou remplace un preset, en mémoire et dans le fichier. |

Les outils d'exécution acceptent en commun : `cwd`, `model`, `sandbox`, `images`, `config`, `enable`, `disable`, `output_schema`, `worktree`, `ephemeral`, `skip_git_repo_check`, `timeout_seconds`.

### Génération d'images

```jsonc
{
  "prompt": "un robot bleu, style plat minimaliste",
  "output_path": "assets/robot.png",
  "use_case": "logo-brand",
  "size": "1024x1024",
  "transparent": true,
  "constraints": "pas de texte, pas de watermark"
}
```

#### Spécialiser une instance : les presets

Le paquet ne connaît aucun sujet en particulier. C'est le **déploiement** qui le spécialise : une instance pointe `CODEX_MCP_IMAGE_PRESETS` vers un fichier JSON décrivant les sujets que son équipe dessine en boucle — une mascotte, un produit, un style maison — et les appelants nomment un preset au lieu de tout redécrire à chaque fois.

```jsonc
// ~/mon-equipe/presets.json — hors du dépôt, propre à l'instance
{
  "mascotte": {
    "subject": "personnage en costume, corps ovoïde vert, antennes en feuille",
    "style": "pixel art 16-bit, palette limitée, contours nets",
    "constraints": "pas de watermark, fond simple",
    "use_case": "stylized-concept",
    "reference_images": ["./ref/mascotte.jpg"]
  }
}
```

```jsonc
{ "preset": "mascotte", "prompt": "de profil, qui salue", "output_path": "sprites/salut.png" }
```

Le preset fournit des **défauts**, jamais un verrou : tout champ donné à l'appel gagne, si bien qu'une image peut s'écarter du style maison sans le redéfinir.

Trois choix qui méritent d'être dits :

- **L'instance annonce ses presets.** Leurs noms sont ajoutés à la description de `codex_generate_image`, sinon l'agent appelant n'aurait aucun moyen d'apprendre qu'ils existent.
- **Les chemins relatifs se résolvent depuis le fichier de presets**, pas depuis le répertoire courant du serveur : le preset et son image de référence voyagent ensemble, alors que le répertoire de lancement est accidentel.
- **Un fichier illisible, un JSON invalide ou un champ inconnu font échouer le démarrage.** Un preset silencieusement ignoré produirait des images génériques qui ressemblent à un raté du modèle, et personne n'irait regarder la configuration.

Les images de référence d'un preset passent par l'allowlist comme les autres : être de la configuration ne vaut pas dérogation.

##### Modifier les presets sans redémarrer

Le fichier est lu au démarrage, mais il n'y est pas figé. Trois outils couvrent la boucle de celui qui affine un sujet :

```jsonc
{ "name": "mascotte", "subject": "…", "style": "pixel art 16-bit" }   // codex_preset_set
{}                                                                     // codex_preset_reload
{}                                                                     // codex_preset_list
```

`codex_preset_set` écrit dans le fichier — un preset qui n'aurait vécu qu'en mémoire disparaîtrait au redémarrage sans que rien ne le dise — et remplace intégralement un preset de même nom, pour qu'un champ puisse être retiré. `codex_preset_reload` sert quand le fichier a été édité à la main.

Deux garanties tiennent des deux côtés :

- **Un changement refusé ne dégrade rien.** La validation porte sur l'ensemble avant de remplacer quoi que ce soit : un JSON cassé ou un champ inconnu laisse en place les presets qui marchaient, et n'écrit pas dans le fichier.
- **L'annonce suit.** La description de `codex_generate_image` nomme les presets, et elle est construite à l'enregistrement de l'outil ; chaque changement la republie et émet `notifications/tools/list_changed`. Sans ça, l'instance connaîtrait un preset que l'agent appelant n'a aucun moyen de découvrir.

Ce qui n'a **pas** été assoupli : un fichier de presets absent ou illisible arrête toujours le serveur au démarrage. Un chemin qui n'existe pas est presque toujours une faute de frappe, et démarrer sans presets est le mode d'échec que tout ceci existe pour empêcher. Pour laisser l'agent remplir le fichier, créez-le avec `{}` — c'est un acte explicite.

L'outil renvoie le **chemin** du fichier, pas les octets : un PNG de 850 Ko pèse ~1,1 Mo en base64 et saturerait le contexte de l'agent appelant.

Codex n'expose aucun service de génération d'images : le protocole app-server contient `ImageGenerationThreadItem` comme *type d'événement* mais aucune méthode RPC `image/*`, et il n'existe pas de sous-commande `codex image`. Le seul accès est agentique — le modèle décide d'appeler son outil interne `image_gen`, guidé par la skill système `imagegen`. Ce serveur en tire deux conséquences :

1. **Le prompt est composé, pas transmis tel quel.** La skill attend une spécification étiquetée (`Use case:`, `Primary request:`, `Constraints:`…) ; lui donner du texte brut dégrade nettement le résultat.
2. **Le fichier doit être retrouvé.** `image_gen` n'émet aucun item JSONL : le flux d'événements ne dit jamais où l'image a atterri. Le serveur vérifie donc `output_path`, puis se rabat sur `$CODEX_HOME/generated_images/<thread_id>/` et y copie le fichier le plus récent. Si les deux échouent, il le dit explicitement plutôt que de renvoyer un chemin fantôme.

## Messagerie bidirectionnelle

Le pont est **toujours actif** : chaque run lancé par ce serveur est démarré avec un serveur MCP supplémentaire, `claude_bridge`, que Codex lance lui-même. Du point de vue de Codex, l'agent Claude qui le supervise est simplement trois outils de plus.

```
agent Claude                 boîte aux lettres            run codex exec
────────────                 ─────────────────            ──────────────
codex_inbox   ──── lit ────▶ un fichier JSON     ◀── écrit ── ask_claude   (bloque)
codex_reply   ─── écrit ───▶  par message        ─── lit ───▶ check_claude
codex_tell    ─── écrit ───▶  (écriture          ─── lit ───▶ check_claude
                              atomique)
```

**Côté Codex** (`claude_bridge`) :

| Outil | Rôle |
|---|---|
| `ask_claude` | Pose une question et **attend** la réponse. Au-delà du délai, rend un `question_id` au lieu d'échouer : la question reste en file et se relève plus tard. |
| `tell_claude` | Envoie un message sans attendre de réponse. |
| `check_claude` | Relève ce que Claude a envoyé depuis le dernier passage, y compris de sa propre initiative, et collecte la réponse à un `ask_claude` expiré. |

**Ce qui rend l'asynchrone supportable des deux côtés.** Claude a un rythme naturel — ses tours d'outils — donc de son côté rien ne bloque : `codex_inbox` rend ce qui est arrivé et coûte presque rien. Codex, lui, ne peut pas reprendre un tour plus tard sans le perdre : c'est donc de ce côté que l'attente est faite, avec une échéance et un identifiant de repli. Une question qui expire n'est jamais perdue.

**Attribution des runs.** Un superviseur peut piloter plusieurs runs simultanément. Chaque message porte le `job_id` du run qui l'a produit, et `codex_reply` renvoie la réponse au run qui a posé la question. Un `codex_tell` sans `job_id` est une diffusion : tous les runs le voient — ce qu'on veut précisément pour un « arrête tout ».

**Le pont ne desserre pas le bac à sable.** Il s'attache par des surcharges `-c` portées par la ligne de commande du run, sans toucher à `$CODEX_HOME` ni à un autre run. Appeler un outil MCP depuis un run sous bac à sable demande normalement une approbation que personne n'est là pour donner ; le pont résout ça par `approvals_reviewer="auto_review"` plus une politique granulaire qui autorise **les seules** sollicitations MCP :

```
approval_policy={granular={mcp_elicitations=true,rules=false,sandbox_approval=false}}
```

Vérifié de bout en bout contre le vrai CLI : sous `-s read-only`, l'appel `ask_claude` aboutit et reçoit sa réponse, tandis que l'écriture d'un fichier est refusée (`writing is blocked by read-only sandbox`). L'élargissement du bac à sable aurait fonctionné aussi, et aurait été le mauvais choix.

## Sécurité

L'installation d'un serveur MCP donne à un agent la capacité d'exécuter du code sur votre machine. Les défauts sont donc restrictifs :

- **Allowlist de répertoires.** Tout `cwd`, `add_dir`, `images`, `output_schema` et `output_path` est résolu en chemin réel — **liens symboliques compris** — puis vérifié comme descendant d'une racine autorisée. Un chemin refusé l'est *avant* tout lancement de processus : un appel rejeté n'a aucun effet de bord.
- **Sandbox par défaut** `workspace-write`, approbations sur `never` (aucun humain n'est là pour répondre ; un refus revient au modèle comme un échec exploitable au lieu de bloquer le run).
- **`danger-full-access` et `--dangerously-bypass-approvals-and-sandbox` sont refusés** sauf `CODEX_MCP_ALLOW_DANGEROUS=1`.

Le garde-fou de chemins ne protège pas contre un Codex lancé en `danger-full-access` : ce mode retire les limites côté Codex lui-même.

## Notes d'implémentation

Trois comportements de Codex 0.154, vérifiés empiriquement, façonnent le code :

1. **Seul `codex exec` accepte `-s/--sandbox`, `-C/--cd`, `--add-dir` et `-p/--profile`.** `exec resume`, `exec fork` et `exec review` ne les ont pas : le sandbox y passe par `-c sandbox_mode="…"`.
2. **Le `codex review` de premier niveau n'a pas `--json`** — seul `codex exec review` l'a. Toutes les revues passent donc par `exec review`.
3. **Codex lit stdin dès qu'il n'est pas sur un TTY** (« Reading additional input from stdin… »). Le prompt est toujours passé via `-` sur stdin, puis stdin est refermé. Cela contourne aussi la limite de 8191 caractères de la ligne de commande Windows et tout l'échappement de quotes.

`codex resume` sans identifiant ouvre un sélecteur TUI, impilotable en MCP : `codex_list_sessions` lit donc directement `$CODEX_HOME/sessions/**/rollout-*.jsonl` (source de vérité) et enrichit avec `$CODEX_HOME/session_index.jsonl`, qui ne contient que les threads *nommés*. Seule la première ligne de chaque rollout est lue — ces fichiers atteignent couramment des dizaines de méga-octets.

Le parseur JSONL est délibérément tolérant : un `item.type` inconnu est conservé tel quel plutôt que rejeté, pour qu'une montée de version de Codex dégrade le résumé au lieu de casser le serveur.

## CI/CD et publication

Deux workflows GitHub Actions, sans secret à configurer : le `GITHUB_TOKEN` fourni automatiquement suffit.

### `ci.yml` — à chaque push et pull request sur `main`

Matrice **Node 22 et 24 × Ubuntu et Windows** : typecheck, tests, build. Windows n'est pas du zèle — l'allowlist de chemins, la gestion des lettres de lecteur et le contournement de la limite de 8191 caractères sont des comportements spécifiquement Windows.

Un job supplémentaire vérifie le **plancher d'exécution** : `package.json` annonce `node >= 22.0`, ce job construit avec une chaîne récente puis charge le `dist/` sous Node 22.0. Les tests ne peuvent pas y tourner (le type stripping exige 22.18), mais la promesse est prouvée au lieu d'être supposée.

### `release.yml` — sur un tag `v*`

```bash
npm version patch   # ou minor / major : met à jour package.json et crée le tag
git push --follow-tags
```

Le workflow rejoue typecheck, tests et build sur **l'arbre exact qui va être publié** — CI prouve qu'un commit est sain, la release prouve que le tag l'est —, puis publie sur `npm.pkg.github.com` et crée la GitHub Release avec des notes générées. Un `workflow_dispatch` permet de rejouer une release à partir d'un tag existant.

**Garde-fou de version** : si le tag et `package.json` divergent, la publication échoue avant le `npm publish`. Une version npm ne pouvant jamais être republiée, une release mal étiquetée serait définitive.

**Scope dérivé à la publication.** GitHub Packages n'accepte qu'un paquet scopé au compte propriétaire. Plutôt que de figer un owner dans le dépôt — ce qui casserait tout fork —, `scripts/github-package.mjs` réécrit le nom en `@owner/mcp-server-codex` au moment de publier, à partir de `github.repository_owner`, en le passant en minuscules (GitHub conserve la casse des comptes, npm la refuse).

### Installer depuis GitHub Packages

Le registre GitHub exige une authentification, **même en lecture**. Dans le `.npmrc` du projet consommateur :

```ini
@owner:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

avec un token portant le scope `read:packages`, puis :

```bash
npm install @owner/mcp-server-codex
```

## Développement

```bash
npm test          # 194 tests, sans lancer Codex ni consommer de tokens
npm run typecheck
npm run build
```

Le développement demande **Node ≥ 22.18**, première version où le type stripping est actif sans drapeau : la suite exécute les `.ts` directement. Le paquet publié, lui, n'est que du JavaScript compilé et tourne dès Node 22.0 — plancher imposé par `execa`, qui déclare `node >=22` et utilise `Set.prototype.union`.

Node exécute TypeScript nativement : ni `tsx` ni `ts-node`.

L'architecture tient à une couture : **toute** interaction avec le système passe par `CodexRunner` (`src/codex/runner.ts`). Les tests unitaires injectent soit un faux binaire Codex scriptable (`test/helpers/fake-codex.mjs`, qui exerce le vrai chemin spawn/stdin/streaming/annulation), soit un runner stub piloté à la main pour les scénarios de timeout et d'annulation.

```
src/
  index.ts            binaire, transport stdio
  runtime.ts          racine de composition
  server.ts           enregistrement MCP des outils
  schemas.ts          schémas zod (les descriptions sont lues par l'agent appelant)
  config.ts           environnement et garde-fous
  codex/argv.ts       pur : options → argv
  codex/events.ts     pur : JSONL → événements typés → résumé
  codex/runner.ts     seule couture avec le système
  codex/sessions.ts   lecture des sessions sur disque
  jobs/store.ts       registre, tampon circulaire, TTL
  jobs/hybrid.ts      course run / timeout
  security/paths.ts   allowlist de racines
  tools/              un fichier par outil
```

## Licence

MIT
