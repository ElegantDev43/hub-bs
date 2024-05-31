import * as React from "react";
import { Client } from "typesense";
import type { SearchParams } from "typesense/lib/Typesense/Documents";
import get from "lodash.get";
import { Slot } from "@radix-ui/react-slot";
import { getHitKey, getHitRecentSearchKey } from "./helpers";

/* -------------------------------------------------------------------------------------------------
 * Utils
 * -----------------------------------------------------------------------------------------------*/

const decodeKey = (_searchKey: string | null) => {
  if (_searchKey === null) {
    return { valid: false } as const;
  }
  const [domain, apiKey, collectionName] = _searchKey.split(":");

  if (typeof domain !== "string") {
    throw new Error(`Couldn't get domain from _searchKey: ${_searchKey}`);
  }
  if (typeof apiKey !== "string") {
    throw new Error(`Couldn't get apiKey from _searchKey: ${_searchKey}`);
  }
  if (typeof collectionName !== "string") {
    throw new Error(
      `Couldn't get collectionName from _searchKey: ${_searchKey}`
    );
  }

  return { domain, apiKey, collectionName, valid: true } as const;
};

const camelToSnake = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function deFlatten(flattened: object) {
  const newObject: Record<string, unknown> = {};
  Object.keys(flattened).forEach((key) => {
    const splitted = key.split(".");
    let previous: any = {};
    let current: any = {};
    splitted.forEach((split, i) => {
      const parent = splitted[i - 1];
      const isFirst = i === 0;
      const isLast = i === splitted.length - 1;

      const splitAsNumber = Number(split);
      const isArrayItem = Number.isNaN(splitAsNumber) === false;

      if (isArrayItem) {
        if (parent) {
          if (!previous[parent] || Array.isArray(previous[parent]) === false) {
            previous[parent] = [];
            current = previous[parent];
          }
        }
      }

      const newVal = {};
      const newKey = isArrayItem ? splitAsNumber : split;

      if (isFirst) {
        previous = newObject;
        newObject[newKey] = isLast
          ? // @ts-ignore
            flattened[key]
          : newObject[newKey] ?? newVal;
        current = newObject[newKey];
      } else {
        previous = current;
        current[newKey] = isLast
          ? // @ts-ignore
            flattened[key]
          : current[newKey] ?? newVal;
        current = current[newKey];
      }
    });
  });
  return newObject;
}

/* -------------------------------------------------------------------------------------------------
 * Get Search Client
 * -----------------------------------------------------------------------------------------------*/

export const getSearchClient = (
  /**
   * The _searchKey taken from a collection of our GraphQL API.
   */
  _searchKey: string | null
) => {
  const { domain, apiKey, valid } = decodeKey(_searchKey);

  if (!valid) return;
  return new Client({
    apiKey,
    nodes: [{ host: domain, port: 443, protocol: "https" }],
  });
};

/* -------------------------------------------------------------------------------------------------
 * useSearch
 * -----------------------------------------------------------------------------------------------*/

export type SearchOptions = {
  queryBy: SearchParams["query_by"];
  filterBy?: SearchParams["filter_by"];
  sortBy?: SearchParams["sort_by"];
  groupBy?: SearchParams["group_by"];
  includeFields?: SearchParams["include_fields"];
  excludeFields?: SearchParams["exclude_fields"];
  page?: SearchParams["page"];
  perPage?: SearchParams["per_page"];
  query?: SearchParams["q"];
  highlightFields?: SearchParams["highlight_fields"];
  highlightFullFields?: SearchParams["highlight_full_fields"];
  highlightStartTag?: SearchParams["highlight_start_tag"];
  highlightEndTag?: SearchParams["highlight_end_tag"];
  limitHits?: SearchParams["limit_hits"];
  pinnedHits?: SearchParams["pinned_hits"];
  hiddenHits?: SearchParams["hidden_hits"];
  offset?: SearchParams["offset"];
  limit?: SearchParams["limit"];
  stopwords?: SearchParams["stopwords"];
  numTypos?: SearchParams["num_typos"];
  prioritizeExactMatch?: SearchParams["prioritize_exact_match"];
  textMatchType?: SearchParams["text_match_type"];
  prefix?: SearchParams["prefix"];
  queryByWeights?: SearchParams["query_by_weights"];
};

export type BaseDoc = {
  _id: string;
  _idPath: string;
  _title?: string;
  _slug?: string;
  _slugPath?: string;
};

export type Highlight = {
  fieldPath: string;
  fieldValue: unknown;
  indices: number[];
  matchedTokens: string[] | string[][];
  snippet: string | undefined;
  snippets: string[];
  value: string | undefined;
};

export type Hit<Doc = Record<string, unknown>> = {
  _key: string;
  document: Doc & BaseDoc;
  highlight: Record<string, Highlight> | undefined;
  highlights: Array<Highlight>;
  curated: boolean;
  _getField: (fieldPath: string) => unknown;
  _getFieldHighlight: (
    fieldPath: string,
    fallbackFieldPaths?: string[]
  ) => ReturnType<typeof _getFieldHighlightImpl>;
};

export type SearchResult<Doc = Record<string, unknown>> = {
  empty: boolean;
  found: number;
  outOf: number;
  page: number;
  searchTimeMs: number;
  hits: Array<Hit<Doc>>;
};

/**
 * See https://typesense.org/docs/26.0/api/search.html#search-parameters
 * for more information about available search options.
 */
export type UseSearchParams<SearchKey = string | null> = {
  /**
   * The _searchKey taken from a collection of our GraphQL API.
   */
  _searchKey: SearchKey;
  saveRecentSearches?: {
    key: string;
    getStorage: () => Storage;
  };
} & SearchOptions;

export type UseSearchResult<Document = Record<string, unknown>> = {
  result: SearchResult<Document> | undefined;
  query: string;
  onQueryChange: (q: string) => Promise<void>;
  recentSearches?: {
    hits: Hit<Document>[] | undefined;
    add: (hit: Hit<Document>) => void;
    remove: (_key: string) => void;
    clear: () => void;
  };
};

/**
 * Everything you need to create an instant-search experience.
 */
export const useSearch = <
  Document extends Record<string, unknown>,
  SearchKey extends string | null = string | null,
>({
  _searchKey,
  saveRecentSearches,
  ...searchOptions
}: UseSearchParams<SearchKey>): SearchKey extends null
  ? { valid: false } & Partial<UseSearchResult<Document>>
  : { valid: true } & UseSearchResult<Document> => {
  const { collectionName, valid } = decodeKey(_searchKey);

  const client = React.useMemo(() => {
    return getSearchClient(_searchKey);
  }, [_searchKey]);

  const [query, setQuery] = React.useState("");
  const [result, setResult] = React.useState<SearchResult<Document>>();
  const [recentSearchesHits, setRecentSearchesHits] =
    React.useState<Hit<Document>[]>();

  const searchOptionsRef = React.useRef(searchOptions);
  searchOptionsRef.current = searchOptions;

  const getRecentSearchesStorageRef = React.useRef(
    saveRecentSearches?.getStorage
  );
  getRecentSearchesStorageRef.current = saveRecentSearches?.getStorage;

  const search = React.useCallback(
    async (q: string, opts?: SearchOptions): Promise<typeof result> => {
      if (!client || !valid) throw new Error("Not enabled");

      const options: Record<string, unknown> = { q };
      Object.entries({ ...searchOptionsRef.current, ...opts }).forEach(
        ([key, value]) => {
          options[camelToSnake(key)] = value;
        }
      );

      const rawResult = await client
        .collections(collectionName)
        .documents()
        .search(options);

      const newResult: typeof result = {
        empty: !rawResult.found,
        found: rawResult.found,
        outOf: rawResult.out_of,
        page: rawResult.page,
        searchTimeMs: rawResult.search_time_ms,
        hits:
          rawResult.hits?.map((hit) => {
            const document = deFlatten(hit.document) as Document & BaseDoc;
            const highlightRecord = {} as Record<string, Highlight>;
            const highlights =
              hit.highlights?.map((highlight) => {
                const fieldPath = highlight.field as string;

                const cast: Highlight = {
                  fieldPath,
                  fieldValue: get(document, fieldPath) as unknown,
                  indices: highlight.indices ?? [],
                  matchedTokens: highlight.matched_tokens,
                  snippet: highlight.snippet,
                  snippets: highlight.snippets ?? [],
                  value: highlight.value,
                };

                highlightRecord[highlight.field as string] = cast;

                return cast;
              }) ?? [];

            const _key = getHitKey(hit);

            const _getField = (fieldPath: string) => {
              return get(document, fieldPath) as unknown;
            };

            const fullHit: Hit<Document> = {
              _key,
              curated: hit.curated ?? false,
              document,
              highlight: highlightRecord,
              highlights,
              _getField,
              _getFieldHighlight: () => null,
            };

            fullHit._getFieldHighlight = (
              fieldPath: string,
              fallbackFieldPaths?: string[]
            ) => {
              return _getFieldHighlightImpl({
                fieldPath,
                fallbackFieldPaths,
                includeFallback: true,
                hit: fullHit,
              });
            };

            return fullHit;
          }) ?? [],
      };

      return newResult;
    },
    [client, collectionName, valid]
  );

  const onQueryChange = React.useCallback(
    async (q: string) => {
      if (!valid) throw new Error("Not enabled");

      setQuery(q);
      if (!q) {
        setResult(undefined);
      } else {
        const r = await search(q);
        setResult(r);
      }
    },
    [search, valid]
  );

  const recentSearchesManager = React.useMemo(() => {
    const storageKey =
      _searchKey && saveRecentSearches?.key
        ? `${saveRecentSearches.key}-${_searchKey}`
        : undefined;

    return {
      add: (hit: Hit<Document>) => {
        if (!getRecentSearchesStorageRef.current || !storageKey) {
          return;
        }
        const storage = getRecentSearchesStorageRef.current();

        const _key = getHitRecentSearchKey(hit);
        const updatedHit = { ...hit, _key };

        setRecentSearchesHits((prev) => {
          // check if this hit already exists
          if (prev) {
            const exists = prev.some((h) => h._key === updatedHit._key);
            if (exists) return prev;
          }

          const next = prev ? [updatedHit, ...prev] : [hit];
          storage.setItem(storageKey, JSON.stringify(next));
          return next;
        });
      },
      remove: (_key: string) => {
        if (!getRecentSearchesStorageRef.current || !storageKey) {
          return;
        }
        const storage = getRecentSearchesStorageRef.current();

        setRecentSearchesHits((prev) => {
          const next = prev?.filter((hit) => hit._key !== _key);
          storage.setItem(storageKey, JSON.stringify(next));
          return next;
        });
      },
      clear: () => {
        if (!getRecentSearchesStorageRef.current || !storageKey) {
          return;
        }
        const storage = getRecentSearchesStorageRef.current();

        setRecentSearchesHits(undefined);
        storage.removeItem(storageKey);
      },
      get: () => {
        if (!getRecentSearchesStorageRef.current || !storageKey) {
          return;
        }
        const storage = getRecentSearchesStorageRef.current();
        const raw = storage.getItem(storageKey);
        if (!raw) return;

        return (JSON.parse(raw) as Hit<Document>[]).map((hit) => {
          hit._getField = (fieldPath: string) => {
            return get(hit.document, fieldPath) as unknown;
          };
          hit._getFieldHighlight = (fieldPath, fallbackFieldPaths) => {
            return _getFieldHighlightImpl({
              fieldPath,
              fallbackFieldPaths,
              includeFallback: true,
              hit: hit,
            });
          };
          return hit;
        });
      },
    };
  }, [_searchKey, saveRecentSearches?.key]);

  // load recent searches
  React.useEffect(() => {
    if (!valid) return;

    const recentHits = recentSearchesManager.get();
    if (recentHits) {
      setRecentSearchesHits(recentHits);
    }
  }, [recentSearchesManager, valid]);

  const memoResult = React.useMemo(() => {
    if (!valid) {
      return { valid: false } satisfies { valid: false } & Partial<
        UseSearchResult<Document>
      >;
    }
    return {
      valid: true,
      result,
      query,
      onQueryChange,
      recentSearches: {
        hits: recentSearchesHits,
        ...recentSearchesManager,
      },
    } satisfies { valid: true } & UseSearchResult<Document>;
  }, [
    valid,
    onQueryChange,
    query,
    result,
    recentSearchesManager,
    recentSearchesHits,
  ]);

  return memoResult as SearchKey extends null
    ? { valid: false } & Partial<UseSearchResult<Document>>
    : { valid: true } & UseSearchResult<Document>;
};

/* -------------------------------------------------------------------------------------------------
 * Search Box
 * -----------------------------------------------------------------------------------------------*/

export type SearchBoxContext<Document = Record<string, unknown>> =
  UseSearchResult<Document> & {
    id: string;
    selectedIndex: number;
    onIndexChange: (
      op: { scrollIntoView?: boolean } & (
        | { type: "incr" | "decr" }
        | { type: "set"; value: number }
      )
    ) => void;
    onHitSelect?: (hit: Hit<Document>) => void;
  };

const Context = React.createContext<SearchBoxContext | undefined>(undefined);

const useContext = () => {
  const ctx = React.useContext(Context);
  if (ctx === undefined) {
    throw new Error(
      "Context not found. Make sure you're rendering Search.Root on top of other Search.* components."
    );
  }
  return ctx;
};

/* -------------------------------------------------------------------------------------------------
 * Root
 * -----------------------------------------------------------------------------------------------*/

const Root = <
  Document extends Record<string, unknown> = Record<string, unknown>,
>({
  children,
  search,
  onHitSelect,
}: {
  children?: React.ReactNode;
  search: ReturnType<typeof useSearch<Document>>;
  onHitSelect?: (hit: Hit<Document>) => void;
}) => {
  const id = React.useId();
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  const handleSelectedNodeDOMMutationsOnIndexChange = React.useCallback(
    (opts: {
      orderedNodes: HTMLElement[] | undefined;
      selectedIndex: number;
      scrollIntoView?: boolean;
    }): boolean => {
      const orderedNodes =
        opts.orderedNodes ||
        Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-basehub-hit-for="${id}"]`
          )
        );

      const selectedNode = orderedNodes[opts.selectedIndex];
      if (!selectedNode) return false;

      orderedNodes.forEach((node, i) => {
        node.dataset.selected = i === opts.selectedIndex ? "true" : "false";
      });

      if (opts.scrollIntoView) {
        selectedNode.scrollIntoView({ block: "nearest" });
      }

      return true;
    },
    [id]
  );

  const onIndexChange: SearchBoxContext["onIndexChange"] = React.useCallback(
    (op) => {
      const orderedNodes = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-basehub-hit-for="${id}"]`)
      );

      setSelectedIndex((prev) => {
        let next = prev;
        switch (op.type) {
          case "set":
            next = op.value;
            break;
          case "incr":
            next = prev + 1;
            break;
          case "decr":
            next = prev - 1;
            break;
          default:
            break;
        }

        const found = handleSelectedNodeDOMMutationsOnIndexChange({
          orderedNodes,
          selectedIndex: next,
          scrollIntoView: op.scrollIntoView,
        });

        if (!found) return prev;

        return next;
      });
    },
    [handleSelectedNodeDOMMutationsOnIndexChange, id]
  );

  const hits = search.valid ? search.result?.hits : undefined;

  // reset selected index when search results change
  React.useEffect(() => {
    setSelectedIndex(0);
    handleSelectedNodeDOMMutationsOnIndexChange({
      orderedNodes: undefined,
      selectedIndex: 0,
      scrollIntoView: true,
    });
  }, [handleSelectedNodeDOMMutationsOnIndexChange, hits]);

  // reset selected index when recent searches are in display (query is empty)
  React.useEffect(() => {
    if (!search.recentSearches?.hits || search.query) return;
    setSelectedIndex(0);
    handleSelectedNodeDOMMutationsOnIndexChange({
      orderedNodes: undefined,
      selectedIndex: 0,
      scrollIntoView: true,
    });
  }, [
    handleSelectedNodeDOMMutationsOnIndexChange,
    search.query,
    search.recentSearches?.hits,
  ]);

  if (search.valid === false) return null;
  return (
    <Context.Provider
      value={{
        ...(search as any),
        id,
        selectedIndex,
        onIndexChange,
        onHitSelect,
      }}
    >
      {children}
    </Context.Provider>
  );
};

/* -------------------------------------------------------------------------------------------------
 * Input
 * -----------------------------------------------------------------------------------------------*/

const useIsoLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

const Input = React.forwardRef<
  HTMLInputElement,
  Omit<
    JSX.IntrinsicElements["input"] & {
      asChild?: boolean;
      disableSelectionPrefill?: boolean;
    },
    "ref"
  >
>(
  (
    { asChild, onChange, onKeyDown, disableSelectionPrefill, ...props },
    ref
  ) => {
    const {
      id,
      query,
      onQueryChange,
      onIndexChange,
      recentSearches,
      result,
      onHitSelect,
    } = useContext();
    const Comp = asChild ? Slot : "input";

    const onQueryChangeRef = React.useRef(onQueryChange);
    onQueryChangeRef.current = onQueryChange;

    const queryRef = React.useRef(query);
    queryRef.current = query;

    useIsoLayoutEffect(() => {
      if (!onQueryChangeRef.current) return;
      const defaultQuery = disableSelectionPrefill
        ? ""
        : window.getSelection()?.toString() || "";

      if (queryRef.current === defaultQuery) return;

      onQueryChangeRef.current(defaultQuery);
    }, [disableSelectionPrefill]);

    return (
      <Comp
        {...props}
        value={query}
        onChange={(e) => {
          onChange?.(e as React.ChangeEvent<HTMLInputElement>);
          if (e.target instanceof HTMLInputElement) {
            onQueryChange(e.target.value);
          }
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e as React.KeyboardEvent<HTMLInputElement>);
          // handle arrow keys and enter
          if (e.key === "ArrowDown") {
            e.preventDefault();
            onIndexChange({ type: "incr", scrollIntoView: true });
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onIndexChange({ type: "decr", scrollIntoView: true });
          } else if (e.key === "Enter") {
            e.preventDefault();
            const selectedNode = document.querySelector<HTMLElement>(
              `[data-basehub-hit-for="${id}"][data-selected="true"]`
            );
            if (selectedNode) {
              const href = selectedNode.getAttribute("href");
              const hit = [
                ...(result?.hits ?? []), // first search in results
                ...(recentSearches?.hits ?? []), // then in recent searches
              ].find((h) => h._key === selectedNode.dataset.basehubHitKey);
              if (href && hit) {
                if (e.metaKey) {
                  window.open(href, "_blank");
                } else {
                  selectedNode.click();
                }
                onHitSelect?.(hit);
                if (recentSearches) {
                  recentSearches.add(hit);
                }
              }
            }
          }
        }}
        ref={ref}
      />
    );
  }
);

/* -------------------------------------------------------------------------------------------------
 * Placeholder
 * -----------------------------------------------------------------------------------------------*/

const Placeholder = React.forwardRef<
  HTMLDivElement,
  Omit<JSX.IntrinsicElements["div"] & { asChild?: boolean }, "ref">
>(({ asChild, ...props }, ref) => {
  const { result } = useContext();
  const Comp = asChild ? Slot : "div";

  if (result !== undefined) return null;
  return <Comp {...props} ref={ref} />;
});

/* -------------------------------------------------------------------------------------------------
 * Empty
 * -----------------------------------------------------------------------------------------------*/

const Empty = React.forwardRef<
  HTMLDivElement,
  Omit<JSX.IntrinsicElements["div"] & { asChild?: boolean }, "ref">
>(({ asChild, ...props }, ref) => {
  const { result } = useContext();
  const Comp = asChild ? Slot : "div";

  if (result?.empty !== true) return null;
  return <Comp {...props} ref={ref} />;
});

/* -------------------------------------------------------------------------------------------------
 * Results
 * -----------------------------------------------------------------------------------------------*/

const HitList = React.forwardRef<
  HTMLDivElement,
  Omit<JSX.IntrinsicElements["div"] & { asChild?: boolean }, "ref">
>(({ asChild, onMouseMove, ...props }, ref) => {
  const { id, onIndexChange } = useContext();
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      {...props}
      ref={ref}
      onMouseMove={(e) => {
        onMouseMove?.(e as React.MouseEvent<HTMLDivElement, MouseEvent>);
        // focus hits
        if (e.target instanceof HTMLElement) {
          const hitEl =
            e.target.dataset.basehubSearchHit === id
              ? e.target
              : e.target.closest<HTMLElement>(`[data-basehub-hit-for="${id}"]`);
          if (!hitEl) return;
          const orderedNodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-basehub-hit-for="${id}"]`
            )
          );
          const index = orderedNodes.indexOf(hitEl);
          if (index === -1) return;
          onIndexChange({ type: "set", value: index });
        }
      }}
    />
  );
});

const HitContext = React.createContext<{ hit: Hit } | undefined>(undefined);

const useHitContext = () => {
  const ctx = React.useContext(HitContext);
  if (ctx === undefined) {
    throw new Error(
      "Context not found. Make sure you're rendering Search.Hit on top of other Search.* components."
    );
  }
  return ctx;
};

const HitItem = React.forwardRef<
  HTMLAnchorElement,
  Omit<
    JSX.IntrinsicElements["a"] & {
      asChild?: boolean;
      hit: Hit;
      href: string;
    },
    "ref"
  >
>(({ asChild, hit, onClick, onFocus, ...props }, ref) => {
  const { id, recentSearches, onIndexChange, onHitSelect } = useContext();
  const Comp = asChild ? Slot : "a";

  return (
    <HitContext.Provider value={{ hit }}>
      <Comp
        {...props}
        data-basehub-hit-for={id}
        data-basehub-hit-key={hit._key}
        ref={ref}
        onClick={(e) => {
          onClick?.(e as React.MouseEvent<HTMLAnchorElement, MouseEvent>);
          onHitSelect?.(hit);
          if (recentSearches) {
            recentSearches.add(hit);
          }
        }}
        onFocus={(e) => {
          onFocus?.(e as React.FocusEvent<HTMLAnchorElement>);
          const orderedNodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-basehub-hit-for="${id}"]`
            )
          );
          const index = orderedNodes.indexOf(e.currentTarget);
          if (index === -1) return;
          onIndexChange({ type: "set", value: index });
        }}
      />
    </HitContext.Provider>
  );
});

const HitSnippet = ({
  fieldPath,
  fallbackFieldPaths,
  components,
}: {
  fieldPath: string;
  fallbackFieldPaths?: string[];
  components?: {
    container?: ({
      children,
    }: {
      children: React.ReactNode;
    }) => React.ReactNode;
    mark?: ({ children }: { children: string }) => React.ReactNode;
    text?: ({ children }: { children: string }) => React.ReactNode;
  };
}) => {
  const { hit } = useHitContext();

  const res = hit._getFieldHighlight(fieldPath, fallbackFieldPaths);
  if (!res) return null;

  const snippet = res.snippet ?? "";

  const matches = [
    ...snippet.matchAll(/(.*?)<mark>(.*?)<\/mark>(.*?)(?=(?:<mark>|$))/gm),
  ];

  const Container = components?.container ?? "div";
  const Text = components?.text ?? "span";
  const Mark = components?.mark ?? "mark";

  return (
    <Container>
      {matches.length > 0 ? (
        matches.map((match, i) => {
          const data = {
            beforeMark: match[1] ?? "",
            insideMark: match[2] ?? "",
            afterMark: match[3] ?? "",
          };

          return (
            <React.Fragment key={i}>
              <Text>{data.beforeMark}</Text>
              <Mark data-highlight>{data.insideMark}</Mark>
              <Text>{data.afterMark}</Text>
            </React.Fragment>
          );
        })
      ) : (
        <Text>{snippet}</Text>
      )}
    </Container>
  );
};

/* -------------------------------------------------------------------------------------------------
 * Hit Utils
 * -----------------------------------------------------------------------------------------------*/

type HighlightedField =
  | undefined
  | {
      _type: "rich-text-section";
      _content: string;
      _id?: string;
      _level?: number;
    }
  | {
      _type: "text";
      _content: string;
    }
  | {
      _type: "unknown";
      _content: unknown;
    };

function _getFieldHighlightImpl({
  hit,
  fieldPath,
  fallbackFieldPaths,
  includeFallback,
}: {
  hit: Hit;
  fieldPath: string;
  fallbackFieldPaths?: string[];
  includeFallback?: boolean;
}): null | {
  highlightedField: HighlightedField;
  snippet: string | undefined;
  snippetByExactMatch: string | undefined;
  snippetByPrefix: string | undefined;
  fallbackSnippet: string | undefined;
} {
  const field = hit._getField(fieldPath);
  if (!field) return null;

  const isRichText =
    Array.isArray(field) && field[0]?._type === "rich-text-section";

  let snippetByExactMatch: string | undefined = undefined;
  let snippetByPrefix: string | undefined = undefined;

  const prefix = fieldPath.endsWith(".") ? fieldPath : fieldPath + ".";

  let highlightedField: HighlightedField = undefined;

  hit.highlights.forEach((h) => {
    if (h.fieldPath !== fieldPath && h.fieldPath.startsWith(prefix) === false) {
      return;
    }
    if (!highlightedField) {
      const adjustedPath = isRichText
        ? h.fieldPath.split(".").slice(0, 2).join(".")
        : h.fieldPath;
      const fieldData = hit._getField(adjustedPath);
      if (!fieldData) return;
      else if (typeof fieldData === "string") {
        highlightedField = {
          _type: "text",
          _content: fieldData,
        };
      } else if (
        typeof fieldData === "object" &&
        "_type" in fieldData &&
        fieldData._type === "rich-text-section"
      ) {
        highlightedField = fieldData as HighlightedField;
      } else {
        highlightedField = {
          _type: "unknown",
          _content: fieldData,
        };
      }
    }

    if (!snippetByExactMatch && h.fieldPath === fieldPath) {
      snippetByExactMatch = h.snippet;
    }
    if (!snippetByPrefix && h.fieldPath.startsWith(prefix)) {
      snippetByPrefix = h.snippet;
    }
  });

  // get first piece of text we find under `field`
  function getFallbackString(
    current: unknown,
    opts: { isRichText: boolean }
  ): string | undefined {
    if (typeof current === "string") return current;

    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const found = current
        .map((c) => getFallbackString(c, opts))
        .find((v) => v);
      return found;
    } else if (typeof current === "object") {
      let found: string | undefined = undefined;
      for (const [key, value] of Object.entries(current)) {
        if (["_id", "_slug"].includes(key)) continue;
        if (opts.isRichText && key !== "_content") {
          continue;
        }
        const processedRecursive = getFallbackString(value, opts);
        if (processedRecursive) {
          found = processedRecursive;
          break;
        }
      }
      return found;
    }
  }

  let fallbackSnippet;
  let snippet: string | undefined =
    snippetByExactMatch || snippetByPrefix || undefined;

  if (snippet === undefined && fallbackFieldPaths && fallbackFieldPaths[0]) {
    const [fallbackFieldPath, ...rest] = fallbackFieldPaths;
    const fallbackResult = _getFieldHighlightImpl({
      hit,
      fieldPath: fallbackFieldPath,
      fallbackFieldPaths: rest,
      includeFallback: false,
    });
    snippet = fallbackResult?.snippet;
    fallbackSnippet = fallbackResult?.snippet;
  }

  if (snippet === undefined && includeFallback) {
    // if snippet is still undefined after trying all fallbacks, we'll fallback to the first piece of text we find in the field
    fallbackSnippet = getFallbackString(field, { isRichText });
    snippet = fallbackSnippet;
  }

  return {
    highlightedField,
    snippet,
    snippetByExactMatch: snippetByExactMatch as string | undefined,
    snippetByPrefix: snippetByPrefix as string | undefined,
    fallbackSnippet,
  };
}

export const SearchBox = {
  Root,
  Input,
  Placeholder,
  Empty,
  HitList,
  HitItem,
  HitSnippet,
  useContext,
  useHitContext,
};
