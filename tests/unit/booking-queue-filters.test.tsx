import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      "queue.searchLabel": "Buscar",
      "queue.stateLabel": "Estado",
      "queue.allStates": "Todos los estados",
      "states.IN_REVIEW": "En revisión",
      "states.APPROVED": "Aprobada",
    })[key] ?? key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/bookings",
}));

import { QueueFilters } from "@/modules/booking/components/queue-filters";

const states = ["IN_REVIEW", "APPROVED"] as const;

function renderFilters(props: Partial<React.ComponentProps<typeof QueueFilters>> = {}) {
  return render(<QueueFilters states={states} search="" state={undefined} {...props} />);
}

function atUrl(query: string) {
  window.history.replaceState({}, "", `/es/bookings${query}`);
}

describe("booking queue filters", () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    atUrl("");
  });

  it("offers no submit button, because filtering follows the typing", () => {
    renderFilters();

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("navigates once for a whole word, not once per keystroke", async () => {
    renderFilters();

    await userEvent.type(screen.getByLabelText("Buscar"), "Berea");

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/bookings?q=Berea", { scroll: false }),
    );
    // Five keystrokes, one navigation: the debounce is doing its job.
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });

  it("applies a state the moment it is chosen", async () => {
    atUrl("?q=Berea");
    renderFilters({ search: "Berea" });

    await userEvent.selectOptions(screen.getByLabelText("Estado"), "APPROVED");

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/bookings?q=Berea&state=APPROVED", {
        scroll: false,
      }),
    );
  });

  it("keeps the sort while filtering", async () => {
    atUrl("?sort=submittedAt&dir=asc");
    renderFilters();

    await userEvent.selectOptions(screen.getByLabelText("Estado"), "IN_REVIEW");

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(
        "/bookings?sort=submittedAt&dir=asc&state=IN_REVIEW",
        { scroll: false },
      ),
    );
  });

  it("reads the sort from the URL, so a slow keystroke cannot undo it", async () => {
    renderFilters();

    // The header link navigates while the operator is still typing.
    await userEvent.type(screen.getByLabelText("Buscar"), "Berea");
    atUrl("?sort=startDate&dir=asc");

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(
        "/bookings?sort=startDate&dir=asc&q=Berea",
        { scroll: false },
      ),
    );
  });

  it("never sends a direction without the column it belongs to", async () => {
    atUrl("?dir=asc");
    renderFilters();

    await userEvent.selectOptions(screen.getByLabelText("Estado"), "IN_REVIEW");

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/bookings?state=IN_REVIEW", {
        scroll: false,
      }),
    );
  });
});
