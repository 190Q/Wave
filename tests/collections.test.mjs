import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());

const { buildCollections, filterCollections, findCollection, isUnknownCollection, playlistGenres } =
  await vite.ssrLoadModule("/src/lib/collections.ts");

function track(id, artist, album, genre) {
  return { id, title: id, artist, album, genre, addedAt: 1, trackNo: null, discNo: null };
}

function collections(tracks) {
  return buildCollections(tracks, [], new Set());
}

test("groups null and blank metadata independently for each collection type", () => {
  const tracks = [
    track("a", null, null, null),
    track("b", "  ", "Album", ""),
    track("c", "Artist", "\t", "Genre"),
    track("d", "Artist", "Album", "Genre"),
  ];
  const result = collections(tracks);

  for (const [kind, expected] of [
    ["artist", ["a", "b"]],
    ["album", ["a", "c"]],
    ["genre", ["a", "b"]],
  ]) {
    const group = findCollection(result, `${kind}:`);
    assert.ok(group);
    assert.equal(group.name, `Unknown ${kind}`);
    assert.equal(group.subtitle, `${kind[0].toUpperCase()}${kind.slice(1)}, 2 songs`);
    assert.deepEqual(group.trackIds, expected);
    assert.deepEqual(group.entries, expected);
    assert.equal(isUnknownCollection(group), true);
  }
  assert.deepEqual(findCollection(result, "artist:artist").trackIds, ["c", "d"]);
  assert.deepEqual(findCollection(result, "album:album").trackIds, ["b", "d"]);
  assert.deepEqual(findCollection(result, "genre:genre").trackIds, ["c", "d"]);
  assert.deepEqual(tracks.map(({ artist, album, genre }) => [artist, album, genre]), [
    [null, null, null], ["  ", "Album", ""], ["Artist", "\t", "Genre"], ["Artist", "Album", "Genre"],
  ]);
});

test("creates unknown collections only when their tags are missing", () => {
  assert.equal(collections([]).some(isUnknownCollection), false);
  assert.equal(collections([track("a", "Artist", "Album", "Genre")]).some(isUnknownCollection), false);

  const result = collections([track("a", null, "Album", "Genre")]);
  assert.equal(result.filter(isUnknownCollection).length, 1);
  assert.equal(findCollection(result, "artist:").subtitle, "Artist, 1 song");
});

test("keeps real tags named Unknown separate and usable for generation", () => {
  const result = collections([
    track("missing", null, null, null),
    track("tagged", "Unknown artist", "Unknown album", "Unknown genre"),
  ]);

  for (const kind of ["artist", "album", "genre"]) {
    const unknown = findCollection(result, `${kind}:`);
    const tagged = findCollection(result, `${kind}:unknown ${kind}`);
    assert.deepEqual(unknown.trackIds, ["missing"]);
    assert.deepEqual(tagged.trackIds, ["tagged"]);
    assert.equal(unknown.name, tagged.name);
    assert.equal(isUnknownCollection(tagged), false);
  }
  assert.deepEqual(playlistGenres(result), ["Unknown genre"]);
  assert.deepEqual(playlistGenres(collections([track("missing", null, null, null)])), []);
});

test("unknown collections are searchable and appear under the right filters", () => {
  const result = collections([track("a", null, null, null)]);
  for (const [filter, kind] of [["artists", "artist"], ["albums", "album"], ["genres", "genre"]]) {
    const visible = filterCollections(result, filter, "unknown", "name");
    assert.deepEqual(visible.map((collection) => collection.id), [`${kind}:`]);
  }
  assert.deepEqual(filterCollections(result, "playlists", "unknown", "name"), []);
});

test("rebuilding after metadata edits moves tracks out of unknown collections", () => {
  const first = collections([track("a", null, null, null), track("b", null, null, null)]);
  const edited = collections([
    track("a", "Artist", "Album", "Genre"),
    track("b", null, null, null),
  ]);
  for (const kind of ["artist", "album", "genre"]) {
    assert.deepEqual(findCollection(first, `${kind}:`).trackIds, ["a", "b"]);
    assert.deepEqual(findCollection(edited, `${kind}:`).trackIds, ["b"]);
    assert.deepEqual(findCollection(edited, `${kind}:${kind}`).trackIds, ["a"]);
  }
});

test("artist collaborations remain grouped without leaking into unknown artists", () => {
  const result = collections([
    track("a", "Alpha", "Album", "Genre"),
    track("b", "Alpha feat. Beta", "Album", "Genre"),
    track("c", null, "Album", "Genre"),
  ]);
  assert.deepEqual(findCollection(result, "artist:alpha").trackIds, ["a", "b"]);
  assert.deepEqual(findCollection(result, "artist:beta").trackIds, ["b"]);
  assert.deepEqual(findCollection(result, "artist:").trackIds, ["c"]);
});
