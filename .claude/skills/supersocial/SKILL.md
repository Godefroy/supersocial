---
name: supersocial
description: Automatiser LinkedIn (chercher/poster des posts, lire/envoyer des DM, lire/poster des commentaires, synchroniser l'inventaire de ses posts). À utiliser dès que l'utilisateur demande une action LinkedIn.
---

# supersocial

CLI locale. Invoquer via `npm run dev -- <commande>` depuis la racine du projet.

## Commandes

```bash
npm run dev -- linkedin throttle:status
npm run dev -- linkedin search <query> [-n 20] [--since past-24h|past-week|past-month]
npm run dev -- linkedin posts:sync [-n 50] [--all]
npm run dev -- linkedin posts:sync:latest [-n 200]
npm run dev -- linkedin inbox:list [-n 30]
npm run dev -- linkedin inbox:read <conversationId>
npm run dev -- linkedin dm <conversationId> <body>
npm run dev -- linkedin comments <postIdOrUrl>
npm run dev -- linkedin comment <postId> <body>
npm run dev -- linkedin publish <body> [--visibility public|connections]
```

Toutes les commandes écrivent leur résultat dans `data/linkedin/` et affichent le fichier produit sur stdout.

## Gestion d'erreur

Si une commande affiche `RateLimitHitError`, arrêter immédiatement toute commande LinkedIn et prévenir l'utilisateur. Ne pas réessayer.

Si `Cookies LinkedIn manquants` ou `Pas de session LinkedIn dans le profil Chrome`, lancer `npm run dev -- linkedin login` pour connecter le profil Chrome persistant.

Si `ThrottleLimitError`, la limite journalière pour cette action est atteinte. Prévenir l'utilisateur et attendre le lendemain, ou lui proposer de consulter `linkedin throttle:status`.

## X/Twitter

Pas encore implémenté. Si l'utilisateur le demande, répondre que seul LinkedIn est supporté pour le moment.
