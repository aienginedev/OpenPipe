import { type Prisma } from "@prisma/client";
import { type JsonValue } from "type-fest";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { prisma } from "~/server/db";
import { hashRequest } from "~/server/utils/hashObject";

const reqValidator = z.object({
  model: z.string(),
  messages: z.array(z.any()),
});

const respValidator = z.object({
  id: z.string(),
  model: z.string(),
  usage: z.object({
    total_tokens: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
  choices: z.array(
    z.object({
      finish_reason: z.string(),
    }),
  ),
});

export const externalApiRouter = createTRPCRouter({
  checkCache: publicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/check-cache",
        description: "Check if a prompt is cached",
      },
    })
    .input(
      z.object({
        startTime: z.number().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        tags: z
          .record(z.string())
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          ),
      }),
    )
    .output(
      z.object({
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const apiKey = ctx.apiKey;
      if (!apiKey) {
        throw new Error("Missing API key");
      }
      const key = await prisma.apiKey.findUnique({
        where: { apiKey },
      });
      if (!key) {
        throw new Error("Invalid API key");
      }
      const reqPayload = await reqValidator.spa(input.reqPayload);
      const cacheKey = hashRequest(key.organizationId, reqPayload as JsonValue);

      const existingResponse = await prisma.loggedCallModelResponse.findFirst({
        where: {
          cacheKey,
        },
        include: {
          originalLoggedCall: true,
        },
        orderBy: {
          startTime: "desc",
        }
      });

      if (!existingResponse) return { respPayload: null };

      await prisma.loggedCall.create({
        data: {
            organizationId: key.organizationId,
            startTime: new Date(input.startTime),
            cacheHit: false,
            modelResponseId: existingResponse.id,
        }
      })

      return {
        respPayload: existingResponse.respPayload,
      };
    }),

  report: publicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/report",
        description: "Report an API call",
      },
    })
    .input(
      z.object({
        startTime: z.number().describe("Unix timestamp in milliseconds"),
        endTime: z.number().describe("Unix timestamp in milliseconds"),
        reqPayload: z.unknown().describe("JSON-encoded request payload"),
        respPayload: z.unknown().optional().describe("JSON-encoded response payload"),
        respStatus: z.number().optional().describe("HTTP status code of response"),
        error: z.string().optional().describe("User-friendly error message"),
        tags: z
          .record(z.string())
          .optional()
          .describe(
            'Extra tags to attach to the call for filtering. Eg { "userId": "123", "promptId": "populate-title" }',
          ),
      }),
    )
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      const apiKey = ctx.apiKey;
      if (!apiKey) {
        throw new Error("Missing API key");
      }
      const key = await prisma.apiKey.findUnique({
        where: { apiKey },
      });
      if (!key) {
        throw new Error("Invalid API key");
      }
      const reqPayload = await reqValidator.spa(input.reqPayload);
      const respPayload = await respValidator.spa(input.respPayload);

      const requestHash = hashRequest(key.organizationId, reqPayload as JsonValue);

      const newLoggedCallId = uuidv4();
      const newModelResponseId = uuidv4();

      const usage = respPayload.success ? respPayload.data.usage : undefined;

      await prisma.$transaction([
        prisma.loggedCall.create({
          data: {
            id: newLoggedCallId,
            organizationId: key.organizationId,
            startTime: new Date(input.startTime),
            cacheHit: false,
            modelResponseId: newModelResponseId,
          },
        }),
        prisma.loggedCallModelResponse.create({
          data: {
            id: newModelResponseId,
            originalLoggedCallId: newLoggedCallId,
            startTime: new Date(input.startTime),
            endTime: new Date(input.endTime),
            reqPayload: input.reqPayload as Prisma.InputJsonValue,
            respPayload: input.respPayload as Prisma.InputJsonValue,
            respStatus: input.respStatus,
            error: input.error,
            durationMs: input.endTime - input.startTime,
            ...(respPayload.success
              ? {
                  cacheKey: requestHash,
                  inputTokens: usage ? usage.prompt_tokens : undefined,
                  outputTokens: usage ? usage.completion_tokens : undefined,
                  model: respPayload.data.model,
                }
              : null),
          },
        }),
      ]);

      if (input.tags) {
        const tagsToCreate = Object.entries(input.tags).map(([name, value]) => ({
          loggedCallId: newLoggedCallId,
          // sanitize tags
          name: name.replaceAll(/[^a-zA-Z0-9_]/g, "_"),
          value,
        }));

        if (reqPayload.success) {
          tagsToCreate.push({
            loggedCallId: newLoggedCallId,
            name: "$model",
            value: reqPayload.data.model,
          });
        }
        await prisma.loggedCallTag.createMany({
          data: tagsToCreate,
        });
      }
    }),
});
