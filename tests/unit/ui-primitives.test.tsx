import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { SidebarProvider } from "@/components/ui/sidebar";

describe("shared UI primitive contracts", () => {
  // The proxy serves a nonce-based CSP with no 'unsafe-inline', and a nonce
  // cannot cover a style attribute. Upstream shadcn sets the sidebar widths
  // inline, which the browser blocks; they belong in globals.css.
  it("lays the sidebar out without a style attribute the CSP would block", () => {
    const { container } = render(
      <SidebarProvider>
        <span>Console</span>
      </SidebarProvider>,
    );

    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.hasAttribute("style")).toBe(false);
  });
  it("keeps checkbox labeling, native form participation, and input refs", async () => {
    const inputRef = createRef<HTMLInputElement>();
    const { container } = render(
      <form>
        <Checkbox id="terms" name="terms" inputRef={inputRef} />
        <label htmlFor="terms">Accept terms</label>
      </form>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Accept terms" });
    expect(inputRef.current).toBeInstanceOf(HTMLInputElement);
    expect(inputRef.current).toHaveAttribute("name", "terms");
    expect(new FormData(container.querySelector("form")!).has("terms")).toBe(false);

    await userEvent.click(screen.getByText("Accept terms"));

    expect(checkbox).toBeChecked();
    expect(new FormData(container.querySelector("form")!).get("terms")).toBe("on");
  });

  it("allows persistent alerts to opt out of assertive announcements", () => {
    render(<Alert role="note">Persistent guidance</Alert>);

    expect(screen.getByRole("note")).toHaveTextContent("Persistent guidance");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("composes destructive alerts with titles, descriptions, and actions", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Request failed</AlertTitle>
        <AlertDescription>Try again later.</AlertDescription>
        <AlertAction>
          <button type="button">Retry</button>
        </AlertAction>
      </Alert>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("text-destructive");
    expect(screen.getByText("Request failed")).toHaveAttribute("data-slot", "alert-title");
    expect(screen.getByText("Try again later.")).toHaveAttribute(
      "data-slot",
      "alert-description",
    );
    expect(screen.getByRole("button", { name: "Retry" }).parentElement).toHaveAttribute(
      "data-slot",
      "alert-action",
    );
  });

  it("renders badges and separators with their intended semantics", () => {
    render(
      <>
        <Badge variant="secondary">Current</Badge>
        <Separator />
      </>,
    );

    expect(screen.getByText("Current")).toHaveAttribute("data-slot", "badge");
    expect(screen.getByRole("separator")).toHaveAttribute("data-orientation", "horizontal");
    expect(badgeVariants({ variant: "outline" })).toContain("border-border");
  });

  it("deduplicates field errors and renders multiple messages as a list", () => {
    const { rerender } = render(
      <FieldError errors={[{ message: "Required" }, { message: "Required" }]} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    rerender(
      <FieldError errors={[{ message: "Required" }, { message: "Too long" }]} />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders the complete field composition without inventing semantics", () => {
    render(
      <FieldSet>
        <FieldLegend variant="label">Preferences</FieldLegend>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldLabel htmlFor="display-name">Display name</FieldLabel>
            <FieldContent>
              <FieldTitle>Public profile</FieldTitle>
              <input id="display-name" />
              <FieldDescription>Shown to collaborators.</FieldDescription>
            </FieldContent>
          </Field>
          <FieldSeparator>or</FieldSeparator>
          <FieldSeparator />
          <FieldError errors={[]} />
        </FieldGroup>
      </FieldSet>,
    );

    expect(document.querySelector('[data-slot="field"]')).toHaveAttribute(
      "data-orientation",
      "responsive",
    );
    expect(screen.getByText("Preferences")).toHaveAttribute("data-slot", "field-legend");
    expect(screen.getByText("Public profile")).toHaveAttribute("data-slot", "field-label");
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
