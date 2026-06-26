
## Writing style

- Always write in French. (except if replying to an english message, then write in english)
- Never use em dashes (`—`). Reformulate.
- Prefer positive formulations over negative ones. E.g. "rester indépendant" rather than "ne pas dépendre", "dès le premier sprint" rather than "pas à la fin".
- Avoid label-colon patterns like "Objectif :", "Result:", "Avantage :". Integrate the information into the sentence.

## General rules

- Never use Claude's user/project memory. When asked to remember something, add a minimal instruction here in `CLAUDE.md` (or in the relevant skill under `.claude/skills/`).

## Règles LinkedIn

Ne jamais charger `linkedin.com/feed/` (ni `/feed/follows`, `/feed/hashtag/...`, ni aucune URL du feed algorithmique) depuis le code supersocial: ça brûle le feed personnalisé de l'utilisateur. Naviguer directement vers l'URL cible (search, profil, permalien post, conversation), pas de warmup préalable. Si un health-check est nécessaire, utiliser une page neutre (ex: `/settings/`, `/in/me/`).

Avant chaque exécution réelle d'une commande `supersocial linkedin *` qui charge une page LinkedIn, demander confirmation à l'utilisateur. Chaque lancement consomme du quota et peut polluer son compte. Ne jamais enchaîner plusieurs runs pour debugger sans demander: inspecter les dumps existants dans `data/.state/debug/` à la place.

Respecter les limites humaines quand plusieurs commandes s'enchaînent: 15-20 invitations/jour, 40-50 DM/jour, fenêtre lu-ve 9h-12h / 14h-18h. Le throttling est géré par `src/core/throttle.ts` mais ne sauve pas d'un enchaînement abusif.

Si une commande remonte `RateLimitHitError` (HTTP 429 ou 999), arrêter immédiatement toute commande LinkedIn pour la journée et prévenir l'utilisateur. Ne pas relancer.

Avant tout retry d'envoi DM dont la tentative précédente a échoué, vérifier que le message n'est pas déjà parti côté LinkedIn. Certains chemins (`compose-no-redirect`, confirmations manquantes) lèvent une exception alors que LinkedIn a accepté l'envoi. La dédup intégrée à `outbox:send` (lecture du thread + comparaison du dernier sortant au body de l'item) couvre ce risque. Ne jamais court-circuiter cette dédup en bricolant un envoi direct sans vérification visuelle de la conversation.

Ne JAMAIS DM une cible qui n'est pas en 1ère relation. LinkedIn refuse l'envoi gratuit et affiche l'upsell Premium/InMail. `outbox:send` applique cette règle automatiquement via un pre-flight `getResolvedTarget` qui lit le degré de relation depuis la page profil (cache partagé avec le `readConversation` qui suit, donc pas de double chargement). Les items dont la cible n'est pas 1ère relation restent en pending sans déclencher d'action LinkedIn (statut `waiting`). Pour les passer à 1ère relation: envoyer une demande de connexion via `linkedin connect <url>` ou queue via `linkedin invite:add <url> --then-dm <body>` qui fait l'invitation + le DM chaîné en une commande.

Si une commande remonte `LinkedInDmRestrictedError`, prévenir l'utilisateur, ne pas retry les items concernés tant que la restriction n'est pas levée. Les autres items 1ère relation peuvent continuer à être traités séparément.

## Extraction DOM

Privilégier les signaux structurels aux mots-clés et regex de contenu quand on extrait des données d'une page LinkedIn. Les classes CSS de LinkedIn sont obfusquées et changent, mais la structure reste stable: rôles ARIA (`[role="listitem"]`, `[role="list"]`), sous-arbre d'un lien (`a[href*="/in/"]`), `<button>`, `span[aria-hidden="true"]` (le texte visible, sans le doublon visually-hidden), ordre des lignes dans un lockup. Lire les champs par position dans le bon conteneur plutôt que par reconnaissance lexicale.

Bannir les heuristiques fragiles et dépendantes de la langue: listes de villes ou de pays pour deviner un lieu, mots de section comme "Poste actuel"/"relations en commun"/"sales navigator", filtres sur le libellé d'un bouton. Exclure plutôt les boutons via leurs `<button>`, scoper via les rôles ARIA, et déduire par ordre d'apparition. Tolérer comme seule exception un petit ensemble fermé et stable (ex: le token de degré `1er/2e/3e/1st…`).

Pour valider ou ajuster un extracteur, s'appuyer sur les dumps `data/.state/debug/` (HTML + innerText + screenshot) plutôt que d'enchaîner des runs réels. Un dump gardé sous `SUPERSOCIAL_DEBUG=true` suffit en général à inspecter la vraie structure.

## Skills Claude Code

Les skills (`.claude/skills/*/SKILL.md`) doivent rester centrées sur leur fonction: frontmatter déclencheur, commandes à exécuter, gestion des erreurs visibles. Ne pas y documenter l'architecture interne, le throttling, le data layout, ni des règles que le code applique déjà.

## Documentation

Le `README.md` reste synthétique et décrit l'installation, l'usage via la skill, et les points d'attention. Toute nouvelle commande CLI, règle d'usage, ou point d'attention qui apparaît au fil du travail doit être reflété dans le `README.md` et la skill correspondante. Le README ne paraphrase pas la skill, il y renvoie.

Le `TODO.md` liste ce qui reste à développer et ce qui est fait. Le maintenir à jour: cocher les items quand une feature est livrée, ajouter les nouvelles idées et améliorations qui émergent, retirer ce qui n'est plus pertinent.
