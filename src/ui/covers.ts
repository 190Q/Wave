import { coverUrl } from "../lib/state";

let observer: IntersectionObserver | null = null;
const observed = new Map<ParentNode, Set<Element>>();

function ensureObserver(): IntersectionObserver {
  if (observer) {
    return observer;
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        const element = entry.target as HTMLElement;
        observer?.unobserve(element);

        const paths = sources.get(element);
        sources.delete(element);
        if (!paths) {
          continue;
        }

        void coverUrl(paths).then((url) => {
          if (!url) {
            return;
          }
          element.replaceChildren();
          element.classList.add("composed");
          element.style.backgroundImage = `url('${url.replace(/'/g, "%27")}')`;
        });
      }
    },
    // Start composing a little before a row scrolls into view.
    { rootMargin: "300px" },
  );

  return observer;
}

const sources = new WeakMap<Element, string[]>();

/** Queues a composed cover for every `data-cover` element inside `root`. */
export function hydrateCovers(root: ParentNode): void {
  const active = ensureObserver();

  for (const element of observed.get(root) ?? []) {
    active.unobserve(element);
  }

  const watching = new Set<Element>();
  observed.set(root, watching);

  for (const element of root.querySelectorAll<HTMLElement>("[data-cover]")) {
    const paths = (element.dataset.cover ?? "").split("|").filter(Boolean);
    element.removeAttribute("data-cover");
    if (paths.length === 0) {
      continue;
    }

    sources.set(element, paths);
    watching.add(element);
    active.observe(element);
  }
}
