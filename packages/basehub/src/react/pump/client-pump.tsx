"use client";
import * as React from "react";
import { PumpProps } from "./server-pump";

import {
  // @ts-ignore
  type QueryGenqlSelection as PumpQuery,
} from "./index";
import type Pusher from "pusher-js/types/src/core/pusher";
import { toast, Toaster } from "sonner";
import type { ResponseCache, PumpState } from "./types";

let pusherMounted = false;
const subscribers = new Set<() => void>(); // we'll call these when pusher tells us to poke

const clientCache = new Map<
  string, // a query string (with the variables included)
  {
    start: number; // the time the query was started
    response: Promise<void | (ResponseCache & { changed: boolean })>; // the promise that resolves to the data
  }
>();

const lastResponseHashCache = new Map<string, string>();

const DEDUPE_TIME_MS = 500;

export const ClientPump = <Queries extends PumpQuery[]>({
  children,
  rawQueries,
  pumpEndpoint,
  pumpToken: initialPumpToken,
  initialState,
  initialResolvedChildren,
  apiVersion,
}: {
  children: PumpProps<Queries>["children"];
  rawQueries: Array<{ query: string; variables?: any }>;
  pumpEndpoint: string;
  pumpToken: string | undefined;
  initialState: PumpState | undefined;
  initialResolvedChildren?: React.ReactNode;
  apiVersion: string;
}) => {
  const pumpTokenRef = React.useRef<string | undefined>(initialPumpToken);
  const [result, setResult] = React.useState<PumpState | undefined>(
    initialState
  );

  type Result = NonNullable<typeof result>;

  const initialStateRef = React.useRef<PumpState | undefined>(initialState);
  initialStateRef.current = initialState;

  /**
   * Query the Draft API.
   */
  const refetch = React.useCallback(async () => {
    let newPumpToken: string | undefined;
    let pusherData: Result["pusherData"] | undefined = undefined;
    let spaceID: Result["spaceID"] | undefined = undefined;

    const responses = await Promise.all(
      rawQueries.map(async (rawQueryOp, index) => {
        if (!pumpTokenRef.current) {
          console.warn("No pump token found. Skipping query.");
          return null;
        }

        const cacheKey = JSON.stringify(rawQueryOp);
        const lastResponseHash =
          lastResponseHashCache.get(cacheKey) ||
          initialStateRef.current?.responseHashes?.[index] ||
          "";

        if (clientCache.has(cacheKey)) {
          const cached = clientCache.get(cacheKey)!;
          if (Date.now() - cached.start < DEDUPE_TIME_MS) {
            const response = await cached.response;
            if (!response) return null;
            if (response.newPumpToken) {
              newPumpToken = response.newPumpToken;
            }
            pusherData = response.pusherData;
            spaceID = response.spaceID;
            return response;
          }
        }

        const responsePromise = fetch(pumpEndpoint, {
          cache: "no-store",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-basehub-pump-token": pumpTokenRef.current,
            "x-basehub-api-version": apiVersion,
            ...(lastResponseHash
              ? { "x-basehub-last-response-hash": lastResponseHash }
              : undefined),
          },
          body: JSON.stringify(rawQueryOp),
        })
          .then(async (response) => {
            const {
              data = null,
              errors = null,
              newPumpToken,
              spaceID,
              pusherData,
              responseHash,
            } = await response.json();

            lastResponseHashCache.set(cacheKey, responseHash);

            return {
              data,
              spaceID,
              pusherData,
              newPumpToken,
              errors,
              responseHash,
              changed: lastResponseHash !== responseHash,
            } as ResponseCache & { changed: boolean };
          })
          .catch((err: unknown) => {
            console.error(err);
            toast.error(
              "Error fetching data from the BaseHub Draft API. Check the console for more information, or contact support@basehub.com for help."
            );
          });

        // we quickly set the cache (without awaiting)
        clientCache.set(cacheKey, {
          start: Date.now(),
          response: responsePromise,
        });

        // then await and set local state
        const response = await responsePromise;
        if (!response) return null;

        if (response.newPumpToken) {
          newPumpToken = response.newPumpToken;
        }
        pusherData = response.pusherData;
        spaceID = response.spaceID;
        return response;
      })
    );

    const shouldUpdate = responses.some((r) => r?.changed);
    if (shouldUpdate) {
      if (!pusherData || !spaceID) return;
      setResult((p) => {
        if (!pusherData || !spaceID) return p;
        return {
          data: responses.map((r, i) => {
            if (!r?.changed) return p?.data?.[i] ?? null;
            return r?.data ?? null;
          }),
          errors: responses.map((r, i) => {
            if (!r?.changed) return p?.errors?.[i] ?? null;
            return r?.errors ?? null;
          }),
          responseHashes: responses.map((r) => r?.responseHash ?? ""),
          pusherData,
          spaceID,
        };
      });
    }

    if (newPumpToken) {
      pumpTokenRef.current = newPumpToken;
    }
  }, [pumpEndpoint, rawQueries, apiVersion]);

  const currentToastRef = React.useRef<string | number | null>(null);

  /**
   * Surface errors.
   */
  React.useEffect(() => {
    if (currentToastRef.current) {
      // first, dismiss current.
      toast.dismiss(currentToastRef.current);
    }

    if (!result?.errors) return;
    const mainError = result.errors[0]?.[0];
    if (!mainError) return;

    currentToastRef.current = toast.error(
      <div style={{ lineHeight: 1.3 }}>
        Error fetching data from the BaseHub Draft API:
        {mainError.message}
        {mainError.path ? (
          <>
            {" "}
            at <ToastInlineCode>{mainError.path?.join(".")}</ToastInlineCode>
          </>
        ) : (
          ""
        )}
        <p
          style={{
            opacity: 0.7,
            fontSize: "0.85em",
            margin: 0,
            marginTop: "0.25em",
          }}
        >
          Check if that block is defined in your BaseHub Repo.
        </p>
      </div>,
      {
        dismissible: true,
        duration: Infinity,
      }
    );
  }, [result?.errors]);

  /**
   * First query plus subscribe to pusher pokes.
   */
  React.useEffect(() => {
    function boundRefetch() {
      refetch();
    }

    boundRefetch(); // initial fetch
    subscribers.add(boundRefetch);
    return () => {
      subscribers.delete(boundRefetch);
    };
  }, [refetch]);

  const [pusher, setPusher] = React.useState<Pusher | null>(null);
  // be specific so that useEffect doesn't re-execute on every new `result` object created
  const pusherChannelKey = result?.pusherData?.channel_key;
  const pusherAppKey = result?.pusherData.app_key;
  const pusherCluster = result?.pusherData.cluster;

  /**
   * Dynamic pusher import!
   */
  React.useEffect(() => {
    if (pusherMounted) return; // dedupe across multiple pumps
    if (!pusherAppKey || !pusherCluster) return;

    pusherMounted = true;

    import("pusher-js")
      .then((mod) => {
        setPusher(new mod.default(pusherAppKey, { cluster: pusherCluster }));
      })
      .catch((err) => {
        console.log("error importing pusher");
        console.error(err);
      });

    return () => {
      pusherMounted = false;
    };
  }, [pusherAppKey, pusherCluster]);

  /**
   * Subscribe to Pusher channel and query.
   */
  React.useEffect(() => {
    if (!pusherChannelKey) return;
    if (!pusher) return;

    const channel = pusher.subscribe(pusherChannelKey);
    channel.bind(
      "poke",
      (message?: Partial<{ mutatedEntryTypes: string[] }>) => {
        if (message?.mutatedEntryTypes?.includes("block")) {
          subscribers.forEach((sub) => sub());
        }
      }
    );

    return () => {
      channel.unsubscribe();
    };
  }, [pusher, pusherChannelKey]);

  const resolvedData = React.useMemo(() => {
    return result?.data.map((r, i) => r ?? initialState?.data?.[i] ?? null);
  }, [initialState?.data, result?.data]);

  const [resolvedChildren, setResolvedChildren] =
    React.useState<React.ReactNode>(
      typeof children === "function"
        ? // if function, we'll resolve in React.useEffect below
          initialResolvedChildren
        : children
    );

  /**
   * Resolve dynamic children
   */
  React.useEffect(() => {
    if (!resolvedData) return;
    if (typeof children === "function") {
      // @ts-ignore
      const res = children(resolvedData);
      if (res instanceof Promise) {
        res.then(setResolvedChildren);
      } else {
        setResolvedChildren(res);
      }
    } else {
      setResolvedChildren(children);
    }
  }, [children, resolvedData]);

  return (
    <>
      {resolvedChildren ?? initialResolvedChildren}
      <Toaster closeButton />
    </>
  );
};

const ToastInlineCode = (props: { children: React.ReactNode }) => {
  return (
    <code
      style={{
        background: "#dddddd",
        color: "red",
        padding: "0.1em 0.3em",
        border: "1px solid #c2c2c2",
        borderRadius: "4px",
      }}
    >
      {props.children}
    </code>
  );
};
