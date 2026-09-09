import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;

export interface SmtpCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export class SmtpError extends Error {
  constructor(
    readonly code: "authentication" | "connection" | "rejected" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/**
 * Maps a transport failure to a category an operator can act on, without
 * echoing the server's response, which can contain the credential.
 */
function classify(error: unknown): SmtpError {
  const code = (error as { code?: string; responseCode?: number })?.code;
  const responseCode = (error as { responseCode?: number })?.responseCode;

  if (code === "EAUTH" || responseCode === 535) {
    return new SmtpError("authentication", "The mail server rejected the credentials");
  }
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS") {
    return new SmtpError("connection", "The mail server could not be reached");
  }
  if (code === "EENVELOPE" || (responseCode !== undefined && responseCode >= 500)) {
    return new SmtpError("rejected", "The mail server refused the message");
  }
  return new SmtpError("unknown", "The message could not be sent");
}

function createTransport(credentials: SmtpCredentials): Transporter {
  return nodemailer.createTransport({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: SMTP_CONNECTION_TIMEOUT_MS,
  });
}

export interface SmtpSender {
  send(message: SmtpMessage): Promise<void>;
  verify(): Promise<void>;
}

export function createSmtpSender(
  credentials: SmtpCredentials,
  senderName: string,
): SmtpSender {
  const transport = createTransport(credentials);

  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: { name: senderName, address: credentials.fromEmail },
          to: message.to,
          replyTo: message.replyTo ?? credentials.fromEmail,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        throw classify(error);
      } finally {
        transport.close();
      }
    },

    /** Used by the settings screen so a wrong credential surfaces on save. */
    async verify() {
      try {
        await transport.verify();
      } catch (error) {
        throw classify(error);
      } finally {
        transport.close();
      }
    },
  };
}
