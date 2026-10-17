# Sure Pet Flap & Feeder for Homey

A [Homey](https://homey.app) app for **Sure Petcare** (Sure Petcare / SureFlap) devices. See where your pets are, control your pet doors, follow what your pets eat and drink, and automate it all with Flows.

> **Unofficial.** This app is not made, endorsed or supported by Sure Petcare. Sure Petcare and SureFlap are trademarks of their owners. It uses the same undocumented cloud API as the official Sure Petcare app, which can change without notice.

## Features

- **Pets**: inside / outside, last seen, how much each pet ate and drank today, number of meals and drinks, trips outside, time outside, the last door used, and weight.
- **Pet doors** (Sure Petcare pet and cat flaps): set the lock mode (Normal, Keep in, Keep out, Locked, Curfew), see battery level, signal strength and online status.
- **Feeders** (SureFeed): bowl weights, last meal, battery level.
- **Water fountains** (Felaqua): water level and volume, battery level.
- **Household widget** for the Homey dashboard: pet cards with photos and status, a one-tap lock-mode bar per pet door, and feeder and fountain overview. Pets can be marked inside or outside from the widget.
- **Flows**: triggers, conditions and actions (see below).
- **Settings page** with the account, a pet and device overview, a force-sync button and the polling interval.
- Languages: English, Dutch, Norwegian.

## Requirements

- Homey Pro with Homey firmware **12.3.0 or later** (the dashboard widget needs it).
- A Sure Petcare account with a Sure Hub in your household.

## How it works

The Sure Petcare hub talks to Sure Petcare's cloud, and this app reads the same cloud API. Your Homey never connects to the hub directly.

- The app logs in with your Sure Petcare account and **polls** the cloud (every 60 seconds by default; you can change the interval in the app settings).
- A pet that walks in and out between two polls shows only its final position.
- Changes you make in Homey (lock mode, marking a pet inside or outside) are sent to the cloud and shown straight away, then confirmed by the next poll.
- Your login is stored in the Homey app settings and is only sent to Sure Petcare.

## Flow cards

**Triggers**

| Device | Cards |
| --- | --- |
| Pet | Came inside, Went outside, Ate food, Drank water, Has been outside too long, Reached daily food goal, Reached daily water goal |
| Pet door | A pet used the door, Lock mode changed, Door went offline, Door came back online |
| Feeder | A pet ate from the feeder, A bowl was refilled, A bowl drops below *x* g |
| Water fountain | A pet drank from the fountain, Reservoir was refilled, Fill level drops below *x*% |
| App | Battery level is low, Intruder attempt (unknown chip at a pet door), Connection problem |

**Conditions**: pet is (not) inside, lock mode is (not) set to *mode*.

**Actions**: set lock mode, set lock mode for a while (then go back to the previous mode), set pet position (inside / outside), set pet access on a door (free or stay inside).

## Install from source

You need [Node.js](https://nodejs.org) 18 or later and the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started).

```bash
npm install
npx homey app run       # run on your Homey with live logs
npx homey app install   # install on your Homey
```

Then open the app in the Homey app settings and log in with your Sure Petcare account. Add your pets, doors, feeders and fountains as devices.

## Development

```bash
npm run build      # TypeScript
npm run lint       # ESLint
npx homey app validate --level publish
```

Project layout:

| Path | Content |
| --- | --- |
| `app.ts` | Shared API client, polling, snapshot and widget data |
| `lib/SureHubClient.ts` | Sure Petcare cloud API client |
| `lib/events.ts` | Compares two snapshots and lists what happened |
| `lib/FlowHandler.ts` | Registers flow cards and fires triggers |
| `drivers/` | `pet`, `flap`, `feeder` and `felaqua` drivers and devices |
| `widgets/household/` | Dashboard widget |
| `settings/` | App settings page |
| `.homeycompose/` | App manifest, capabilities and flow cards |

## Screenshots

Widget with example data:

![Household widget, dark](mockups/widget-en-dark-tablet-overview.png)

![Household widget, light](mockups/widget-en-light-narrow-overview.png)

## Credits

Thanks to the community projects that documented the Sure Petcare API: [surepy](https://github.com/benleb/surepy), [surehub-api](https://github.com/fabieu/surehub-api) and the Home Assistant [Sure Petcare integration](https://www.home-assistant.io/integrations/surepetcare/).

## License

[MIT](LICENSE)
