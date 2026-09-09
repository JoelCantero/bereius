// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMail = vi.fn();
const verify = vi.fn();
const close = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail, verify, close })),
  },
}));

import { createSmtpSender, SmtpError } from "@/lib/mail/smtp";

const credentials = {
  host: "mail.example.test",
  port: 587,
  secure: false,
  username: "hola@example.test",
  password: "super-secret-password",
  fromEmail: "hola@example.test",
};

function sender() {
  return createSmtpSender(credentials, "bereius");
}

describe("booking SMTP sender", () => {
  it("sends from the configured mailbox with the project as display name", async () => {
    sendMail.mockResolvedValueOnce({});

    await sender().send({
      to: "group@example.test",
      subject: "Booking confirmed",
      text: "Your booking is confirmed",
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: "bereius", address: "hola@example.test" },
        to: "group@example.test",
        replyTo: "hola@example.test",
      }),
    );
  });

  it("closes the connection even when sending fails", async () => {
    close.mockClear();
    sendMail.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: "EAUTH" }));

    await expect(
      sender().send({ to: "group@example.test", subject: "s", text: "t" }),
    ).rejects.toBeInstanceOf(SmtpError);
    expect(close).toHaveBeenCalled();
  });

  it.each([
    [{ code: "EAUTH" }, "authentication"],
    [{ responseCode: 535 }, "authentication"],
    [{ code: "ECONNECTION" }, "connection"],
    [{ code: "ETIMEDOUT" }, "connection"],
    [{ code: "EENVELOPE" }, "rejected"],
    [{ responseCode: 550 }, "rejected"],
    [{ code: "WHATEVER" }, "unknown"],
  ])("classifies %j as %s", async (raw, expected) => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error("failure"), raw));

    await expect(
      sender().send({ to: "group@example.test", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ code: expected });
  });

  it("never echoes the credential or the server response in the error", async () => {
    sendMail.mockRejectedValueOnce(
      Object.assign(
        new Error("535 auth failed for user hola with password super-secret-password"),
        { code: "EAUTH" },
      ),
    );

    try {
      await sender().send({ to: "group@example.test", subject: "s", text: "t" });
      expect.unreachable("expected the send to fail");
    } catch (error) {
      const output = `${String(error)}${(error as Error).message}`;
      expect(output).not.toContain("super-secret-password");
      expect(output).not.toContain("535 auth failed");
    }
  });

  it("verifies the connection for the settings screen", async () => {
    verify.mockResolvedValueOnce(true);

    await expect(sender().verify()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalled();
  });

  it("reports an unreachable server on verification", async () => {
    verify.mockRejectedValueOnce(
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    );

    await expect(sender().verify()).rejects.toMatchObject({ code: "connection" });
  });
});
