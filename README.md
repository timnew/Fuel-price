# Fuel-price

An 711 fuel price monitor by data from [Project Zero Three](https://projectzerothree.info/)

## How to deploy

https://developers.google.com/apps-script/guides/typescript

In general:

1. Install `clasp`: `npm install -g @google/clasp`
2. `yarn install`
3. `clasp push`

If clasp complains about cannot found `appsscript.json`, check the path in `.clasp.json`, which is required to be absolute path and the one on github might not match the local one.
