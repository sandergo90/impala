import { invoke } from "@/lib/invoke";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useMountEffect } from "@/hooks/useMountEffect";
import { codexRemotePairingUrl } from "@/lib/codex-remote";
import {
  Check,
  CircleCheck,
  Copy,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useRef, useState } from "react";
import { toast } from "sonner";

interface CodexRemoteClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

interface CodexRemoteSnapshot {
  status: "offline" | "disabled" | "connecting" | "connected" | "errored";
  environmentId: string | null;
  clients: CodexRemoteClient[];
}

interface CodexRemotePairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
}

interface CodexRemotePairingStatus {
  claimed: boolean;
}

type PendingAction = "pair" | "refresh" | `revoke:${string}` | null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientName(client: CodexRemoteClient): string {
  return client.displayName || client.deviceModel || "ChatGPT device";
}

function clientDetails(client: CodexRemoteClient): string {
  const platform = [client.platform, client.osVersion].filter(Boolean).join(" ");
  return [platform, client.appVersion ? `ChatGPT ${client.appVersion}` : null]
    .filter(Boolean)
    .join(" · ");
}

function pairingExpiry(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CodexRemotePane() {
  const mountedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<CodexRemoteSnapshot | null>(null);
  const [pairing, setPairing] = useState<CodexRemotePairing | null>(null);
  const [pairingExpired, setPairingExpired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPairing, setConfirmPairing] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<CodexRemoteClient | null>(null);

  useMountEffect(() => {
    mountedRef.current = true;
    void refreshSnapshot();
    return () => {
      mountedRef.current = false;
      pollGenerationRef.current += 1;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  });

  async function refreshSnapshot(showPending = false) {
    if (showPending) setPendingAction("refresh");
    setError(null);
    try {
      const next = await invoke<CodexRemoteSnapshot>("get_codex_remote_snapshot");
      if (mountedRef.current) setSnapshot(next);
    } catch (nextError) {
      if (mountedRef.current) setError(errorMessage(nextError));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        if (showPending) setPendingAction(null);
      }
    }
  }

  function stopPairingPoll() {
    pollGenerationRef.current += 1;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }

  function schedulePairingPoll(nextPairing: CodexRemotePairing, generation: number) {
    if (Date.now() >= nextPairing.expiresAt * 1000) {
      if (mountedRef.current && generation === pollGenerationRef.current) {
        setPairingExpired(true);
      }
      return;
    }

    pollTimerRef.current = setTimeout(async () => {
      if (!mountedRef.current || generation !== pollGenerationRef.current) return;
      try {
        const status = await invoke<CodexRemotePairingStatus>(
          "get_codex_remote_pairing_status",
          { pairingCode: nextPairing.pairingCode },
        );
        if (!mountedRef.current || generation !== pollGenerationRef.current) return;
        if (status.claimed) {
          stopPairingPoll();
          setPairing(null);
          setPairingExpired(false);
          toast.success("iPhone connected to Impala Remote");
          await refreshSnapshot();
          return;
        }
        schedulePairingPoll(nextPairing, generation);
      } catch (nextError) {
        if (mountedRef.current && generation === pollGenerationRef.current) {
          setError(`Could not check the pairing: ${errorMessage(nextError)}`);
        }
      }
    }, 1500);
  }

  async function startPairing() {
    stopPairingPoll();
    setConfirmPairing(false);
    setPendingAction("pair");
    setPairing(null);
    setPairingExpired(false);
    setError(null);
    try {
      const nextPairing = await invoke<CodexRemotePairing>(
        "start_codex_remote_pairing",
      );
      if (!mountedRef.current) return;
      setPairing(nextPairing);
      const generation = pollGenerationRef.current;
      schedulePairingPoll(nextPairing, generation);
      await refreshSnapshot();
    } catch (nextError) {
      if (mountedRef.current) {
        setError(`Could not start Codex Remote: ${errorMessage(nextError)}`);
      }
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  async function revokeClient() {
    if (!removeTarget || !snapshot?.environmentId) return;
    const target = removeTarget;
    setRemoveTarget(null);
    setPendingAction(`revoke:${target.clientId}`);
    setError(null);
    try {
      await invoke("revoke_codex_remote_client", {
        environmentId: snapshot.environmentId,
        clientId: target.clientId,
      });
      if (!mountedRef.current) return;
      toast.success(`Removed access for ${clientName(target)}`);
      await refreshSnapshot();
    } catch (nextError) {
      if (mountedRef.current) {
        setError(`Could not remove device access: ${errorMessage(nextError)}`);
      }
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  async function copyManualCode() {
    if (!pairing?.manualPairingCode) return;
    try {
      await navigator.clipboard.writeText(pairing.manualPairingCode);
      toast.success("Pairing code copied");
    } catch (copyError) {
      setError(`Could not copy the pairing code: ${errorMessage(copyError)}`);
    }
  }

  const clients = snapshot?.clients ?? [];
  const connected = snapshot?.status === "connected";
  const checking = loading && snapshot === null;
  const loadFailed = error !== null && snapshot === null;
  const statusLabel = checking
    ? "Checking Codex Remote"
    : loadFailed
      ? "Could not load Codex Remote"
    : snapshot?.status === "connected"
      ? clients.length > 0
        ? "Connected"
        : "Remote host online"
      : snapshot?.status === "connecting"
        ? "Connecting to ChatGPT"
        : snapshot?.status === "errored"
          ? "Remote connection error"
          : "No Remote host running";

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">Remote</h4>
        <p className="text-sm text-muted-foreground">
          Continue Impala Codex sessions from the ChatGPT app on your iPhone.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-start gap-3 p-4">
          <div
            className={`mt-0.5 shrink-0 ${
              checking || snapshot?.status === "connecting"
                ? "text-warning"
                : loadFailed
                  ? "text-destructive"
                : connected
                  ? "text-success"
                  : snapshot?.status === "errored"
                    ? "text-destructive"
                    : "text-muted-foreground"
            }`}
            aria-hidden="true"
          >
            {checking || snapshot?.status === "connecting" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : loadFailed || snapshot?.status === "errored" ? (
              <TriangleAlert className="size-4" />
            ) : connected ? (
              <CircleCheck className="size-4" />
            ) : (
              <WifiOff className="size-4" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{statusLabel}</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {loadFailed
                ? "Retry to check the local Codex app-server."
                : connected
                ? "Impala is the Remote host for these Codex sessions."
                : "Impala starts the Remote host when you connect a phone or launch Codex."}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refreshSnapshot(true)}
            disabled={pendingAction !== null || checking}
            aria-label="Refresh Codex Remote status"
            title="Refresh status"
          >
            <RefreshCw
              className={pendingAction === "refresh" ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </Button>
        </div>

        <div className="mx-4 mb-4 flex gap-2 rounded-md bg-muted/60 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-muted-foreground">
            Use one Remote host per Mac. Remove this iPhone from ChatGPT Desktop Remote before
            pairing it here, otherwise the same sessions appear twice.
          </p>
        </div>

        {pairing ? (
          <div className="border-t border-border p-4">
            {pairingExpired ? (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Pairing code expired</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Generate a new code to connect your iPhone.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setConfirmPairing(true)}
                  disabled={pendingAction !== null}
                >
                  Generate new code
                </Button>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
                <div className="w-fit rounded-lg bg-white p-2 ring-1 ring-black/10">
                  <QRCodeSVG
                    value={codexRemotePairingUrl(pairing.pairingCode)}
                    size={152}
                    level="M"
                    marginSize={2}
                    title="Codex Remote pairing code"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LoaderCircle className="size-4 animate-spin text-warning" aria-hidden="true" />
                    Waiting for your iPhone
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    In ChatGPT, open Settings → Connections → Remote and scan this code.
                  </p>
                  {pairing.manualPairingCode ? (
                    <div className="mt-3 flex items-center gap-2">
                      <code className="rounded bg-muted px-2 py-1 font-mono text-sm text-foreground">
                        {pairing.manualPairingCode}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void copyManualCode()}
                        aria-label="Copy manual pairing code"
                        title="Copy code"
                      >
                        <Copy aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Expires at {pairingExpiry(pairing.expiresAt)}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="border-t border-border p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-medium">Connected devices</h4>
              {clients.length === 0 ? (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  No iPhone currently has access to this Remote host.
                </p>
              ) : null}
            </div>
            {!pairing ? (
              <Button
                size="sm"
                onClick={() => setConfirmPairing(true)}
                disabled={pendingAction !== null || checking}
              >
                {pendingAction === "pair" ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Smartphone aria-hidden="true" />
                )}
                {clients.length > 0 ? "Pair another" : "Connect iPhone"}
              </Button>
            ) : null}
          </div>

          {clients.length > 0 ? (
            <ul className="mt-3 divide-y divide-border border-t border-border">
              {clients.map((client) => (
                <li key={client.clientId} className="flex items-center gap-3 py-3 last:pb-0">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Smartphone className="size-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {clientName(client)}
                      <Check className="size-3.5 text-success" aria-label="Access granted" />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {clientDetails(client) || "ChatGPT Remote device"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveTarget(client)}
                    disabled={pendingAction !== null}
                  >
                    {pendingAction === `revoke:${client.clientId}` ? (
                      <LoaderCircle className="animate-spin" aria-hidden="true" />
                    ) : null}
                    Remove access
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {error ? (
          <div className="border-t border-border px-4 py-3" role="status" aria-live="polite">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setError(null);
                  if (pairing && !pairingExpired) {
                    schedulePairingPoll(pairing, pollGenerationRef.current);
                  } else {
                    void refreshSnapshot(true);
                  }
                }}
                disabled={pendingAction !== null}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <AlertDialog open={confirmPairing} onOpenChange={setConfirmPairing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use Impala as this Mac’s Remote host?</AlertDialogTitle>
            <AlertDialogDescription>
              A phone paired to both Impala and ChatGPT Desktop sees duplicate sessions. Remove
              this phone from the ChatGPT Desktop Remote connection first. Impala will not change
              that connection automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void startPairing()}>
              Use Impala Remote
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove iPhone access?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `${clientName(removeTarget)} will no longer be able to open or continue sessions through this Impala Remote host.`
                : "This device will no longer have access to Impala Remote."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void revokeClient()}>
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
