# Quiet lists preview

This token-free fixture renders the actual Tasks panel, at 320px wide, without a storage owner or model. It mocks the event stream locally.

From the checkout being reviewed:

```sh
node --input-type=module -e "import {createServer} from 'vite-plus'; const s=await createServer({configFile:process.cwd()+'/vite.config.ts',root:process.cwd(),server:{host:'127.0.0.1',port:5199}});await s.listen();s.printUrls()"
```

Open the printed URL plus `test/web/quiet-lists.html`. Stop with Ctrl+C. Choose another port if 5199 is occupied. Screenshot at 900×800 or wider.

The fixture includes a long landed title (ready checkout, zero ahead), failed nested child, preparing/busy untitled child, busy worker with two commits ahead, an untitled root, and running/waiting/background/aborting tasks. In the browser console:

```js
fixture.archive([2]) // hides the landed worker AND its nested failed child and tasks
fixture.archive([1]) // hides the whole first root subtree
fixture.archive([]) // restores all rows and counts
fixture.summaries([{ id: 1 }, { id: 6 }]) // simulate child summaries still in flight
fixture.archive([1]) // only #6's run remains, despite null-owner child runs
fixture.summaries() // full summaries arrive; archived tasks remain hidden
fixture.archive([]) // restore
```

Regression command:

```sh
pnpm test test/quiet-lists-browser.test.ts
```
