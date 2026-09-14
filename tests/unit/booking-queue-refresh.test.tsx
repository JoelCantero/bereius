import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) =>
    (key: string, values?: Record<string, number>) => {
      if (namespace === "Bookings.errors") return `error:${key}`;
      if (key === "refresh") return "Actualizar solicitudes";
      if (key === "refreshing") return "Actualizando solicitudes";
      if (key === "refreshResult") {
        return `Importadas ${values?.created}; existentes ${values?.skipped}; rechazadas ${values?.rejected}`;
      }
      return key;
    },
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import type { IntakeActionState } from "@/modules/booking/actions/intake";
import { QueueRefresh } from "@/modules/booking/components/queue-refresh";

function deferredAction() {
  let settle: ((state: IntakeActionState) => void) | undefined;
  const action = vi.fn(
    () =>
      new Promise<IntakeActionState>((resolveAction) => {
        settle = resolveAction;
      }),
  );

  return {
    action,
    resolve(state: IntakeActionState) {
      if (!settle) throw new Error("refresh action has not started");
      settle(state);
    },
  };
}

describe("booking queue refresh", () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
  });

  it("disables repeat submissions while intake is running", async () => {
    const user = userEvent.setup();
    const request = deferredAction();
    render(<QueueRefresh action={request.action} />);

    const button = screen.getByRole("button", { name: "Actualizar solicitudes" });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Actualizando solicitudes");
    await user.click(button);
    expect(request.action).toHaveBeenCalledOnce();

    request.resolve({ status: "done", created: 1, skipped: 2, rejected: 3 });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Importadas 1; existentes 2; rechazadas 3",
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("shows a translated provider error", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<IntakeActionState> => ({
      status: "error",
      reason: "connection",
    }));
    render(<QueueRefresh action={action} />);

    await user.click(screen.getByRole("button", { name: "Actualizar solicitudes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("error:connection");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});