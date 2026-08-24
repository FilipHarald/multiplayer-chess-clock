# Agent Browser Guide

This guide shows an agent how to reach the hosted Multiplayer Chess Clock,
interact with it through a real Chromium session, and capture screenshots.

## Hosted address

The test instance is available to devices and agents on the same Tailscale
network:

```text
http://100.70.0.46:3002
```

Room state is held in server memory. A room disappears after the server is
restarted, and may be cleaned up after its players disconnect. Create a fresh
room rather than relying on a room code from an earlier session.

## Check reachability

Confirm that the server responds before starting a browser:

```bash
curl -I --max-time 10 http://100.70.0.46:3002
```

A reachable instance returns `HTTP/1.1 200 OK`. If the request times out,
confirm that the agent is connected to Tailscale and that the app is running on
port 3002.

## Capture the home page

Chromium can render the app headlessly and write a 1440 x 1200 PNG:

```bash
chromium \
  --headless \
  --disable-gpu \
  --no-sandbox \
  --hide-scrollbars \
  --window-size=1440,1200 \
  --virtual-time-budget=4000 \
  --screenshot=/tmp/multiplayer-chess-clock-home.png \
  http://100.70.0.46:3002
```

The virtual-time budget gives React and the public-room request time to render
before Chromium takes the screenshot.

## Create a room through the real UI

Use ChromeDriver when the task requires interaction rather than a static page
load. The following example uses only ChromeDriver and `curl`.

Start ChromeDriver in one terminal and keep it running:

```bash
chromedriver --port=9515 --allowed-ips=127.0.0.1
```

Create a headless Chromium session from another terminal:

```bash
curl -sS -X POST http://127.0.0.1:9515/session \
  -H 'Content-Type: application/json' \
  --data '{
    "capabilities": {
      "alwaysMatch": {
        "browserName": "chrome",
        "goog:chromeOptions": {
          "args": [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--window-size=1440,1200"
          ]
        }
      }
    }
  }'
```

Copy the returned `sessionId` and substitute it for `<SESSION_ID>` below.
Navigate to the app:

```bash
curl -sS -X POST \
  http://127.0.0.1:9515/session/<SESSION_ID>/url \
  -H 'Content-Type: application/json' \
  --data '{"url":"http://100.70.0.46:3002"}'
```

Click the **Create Clock** button using its visible label:

```bash
curl -sS -X POST \
  http://127.0.0.1:9515/session/<SESSION_ID>/execute/sync \
  -H 'Content-Type: application/json' \
  --data '{
    "script": "const button = [...document.querySelectorAll(\u0027button\u0027)].find(element => element.textContent.includes(\u0027Create Clock\u0027)); if (!button) throw new Error(\u0027Create Clock button not found\u0027); button.click(); return true;",
    "args": []
  }'
```

Verify that navigation reached a newly generated room URL:

```bash
curl -sS http://127.0.0.1:9515/session/<SESSION_ID>/url
```

The response should contain a URL shaped like:

```text
http://100.70.0.46:3002/room/ROOM_CODE
```

For a stronger assertion, inspect the rendered text:

```bash
curl -sS -X POST \
  http://127.0.0.1:9515/session/<SESSION_ID>/execute/sync \
  -H 'Content-Type: application/json' \
  --data '{"script":"return document.body.innerText;","args":[]}'
```

The waiting room should include `Waiting Room`, `Player 1`, `YOU`, and `HOST`.
With the default three-player room it also says `Need at least 2 players`.

## Capture the interactive browser state

Use WebDriver's screenshot endpoint so the image comes from the same browser
session that created the room. The response is JSON containing a base64 PNG:

```bash
curl -sS \
  http://127.0.0.1:9515/session/<SESSION_ID>/screenshot \
  | jq -r '.value' \
  | base64 --decode \
  > /tmp/multiplayer-chess-clock-room.png
```

Do not open the room URL in a separate temporary browser merely to capture it:
that browser has a different device identity and may join as another player or
remain on `Loading room...`. Capturing the existing WebDriver session preserves
the state being tested.

## Clean up

Close the browser session when finished:

```bash
curl -sS -X DELETE \
  http://127.0.0.1:9515/session/<SESSION_ID>
```

Then stop the ChromeDriver process. Screenshots intended for Buzz can be
uploaded with `buzz upload file --file <PNG_PATH>` and embedded in a message
using the returned media URL.

## Verified workflow

This procedure was exercised against the hosted instance on 2026-08-24. It
returned HTTP 200, created room `o9K-N-` through the **Create Clock** button,
identified the creating browser as Player 1 and host, and produced screenshots
of both the home page and the waiting room.
