# Getting started (15 minutes)

You will run Syncra locally, open the two demo apps, then add offline sync to a small React app.
Syncra is built on [Yjs](https://yjs.dev). Documents are Yjs documents; Syncra adds the server, tenancy, quotas, dashboard and a client runtime.

## 1. Start the stack (about 5 minutes)

You need Docker with Compose v2.

```bash
git clone https://github.com/munawwar-ali/syncra.git
cd syncra
docker compose -f infra/compose/docker-compose.yml up
```

The first start builds the images, so it takes a few minutes. When the `migrate` service finishes, it prints a block like this and saves it to `.syncra/.syncra-demo-credentials.txt`:

```
==================== Syncra demo credentials ====================
Dashboard:         http://localhost:8080/
Login:             demo@syncra.dev
Password:          ...
Publishable key:   pk_live_...
Secret key:        sk_live_...
Demo notes app:    http://localhost:8080/notes/
Demo inspections:  http://localhost:8080/inspection/
```

These are shown once. Rotate them before exposing the instance to a network.

::: warning Status
The compose stack has been validated with `docker compose config`, but its images have not been built or run by the project's author yet. If a step fails, please open an issue.
:::

## 2. Try the demos (about 3 minutes)

1. Open the **notes** app in two browser windows and sign in with two names.
2. Type in one window and watch the other update. Click **Go offline** in the chaos panel, type more, reload the page, then go online. Both windows end with the same text.
3. Open the **inspections** app. Sign in as an Inspector, open a site, start an inspection, then switch your browser to offline mode and keep working.
4. Open the **dashboard** and log in. The overview shows live operations per second; the document inspector lets you scrub through a document's history.

## 3. Add Syncra to your app (about 7 minutes)

Packages are not published to npm yet. Use the workspace packages from the cloned repository (`packages/client`, `packages/react`), or `pnpm pack` them.

Your backend mints a short-lived token for each signed-in user, using your **secret key**. Never ship the secret key to a browser.

```ts
// your backend
const res = await fetch('http://localhost:8080/v1/tokens', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.SYNCRA_SECRET_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    userId: 'user-42',
    ttlSeconds: 3600,
    access: [{ collection: 'todos', docs: '*', mode: 'rw' }],
  }),
});
const { token } = await res.json();
```

In the browser:

```tsx
import { createClient } from '@syncra/client';
import { SyncraProvider, useDoc, useYMap, useSyncStatus } from '@syncra/react';

const client = createClient({
  url: 'http://localhost:8080',
  publishableKey: 'pk_live_...',
  getToken: () =>
    fetch('/api/syncra-token')
      .then((r) => r.json())
      .then((j) => j.token),
});

function Todo({ id }: { id: string }) {
  const { doc } = useDoc('todos', id);
  const todo = useYMap<{ title?: string; done?: boolean }>(doc);
  const status = useSyncStatus();
  return (
    <label>
      <input
        type="checkbox"
        checked={todo.done ?? false}
        onChange={(e) => doc?.setFields({ done: e.target.checked })}
      />
      {todo.title ?? '...'} ({status.connection}, {status.pendingOps} unsynced)
    </label>
  );
}

export const App = () => (
  <SyncraProvider client={client}>
    <Todo id="first" />
  </SyncraProvider>
);
```

Edits are written to IndexedDB first, so the app works with no network. They are sent when a connection is available.

## Check that it works

Open the app, turn the network off in your browser tools, change the checkbox, reload, and turn the network back on. The unsynced counter returns to 0, and the dashboard's document browser shows the change.

## Next

- [SDK guide](./sdk-guide.md)
- [Self-hosting](./self-hosting.md)
- [Architecture](./architecture.md)
