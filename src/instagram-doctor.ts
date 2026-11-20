import type { DoctorCheck } from "./doctor-command.js";
import {
  describeTokenHealth,
  inspectInstagramConnection,
  type InstagramDeps,
  PUBLISH_PERMISSION,
  readPublishingLimit
} from "./instagram-account.js";
import { type HostingDeps, testImageHosting } from "./instagram-hosting.js";

/**
 * UNC-298: Instagram items for `uncommitted doctor` — connection, token
 * expiry, publish permission, image hosting round trip, and today's
 * publishing limit. An unconnected account is one optional pass item and
 * makes no keychain or network call. Messages never carry secret values.
 */

export type InstagramDoctorDeps = InstagramDeps &
  Pick<HostingDeps, "hostingFetch"> & {
    /** ISO timestamp for token expiry math. */
    now?: () => string;
  };

const CONFIG_EXIT_CODE = 2;

export async function createInstagramDoctorChecks(
  deps: InstagramDoctorDeps
): Promise<DoctorCheck[]> {
  const inspection = await inspectInstagramConnection(deps);

  if (inspection.state === "not-connected") {
    return [
      {
        id: "instagram-connection",
        label: "Instagram",
        status: "pass",
        message: "연결 안 됨 (게시를 쓰지 않으면 무시해도 됩니다)."
      }
    ];
  }

  if (inspection.state === "error") {
    return [
      {
        id: "instagram-connection",
        label: "Instagram",
        status: "fail",
        message: inspection.message,
        exitCode: inspection.exitCode
      }
    ];
  }

  const checks: DoctorCheck[] = [
    {
      id: "instagram-connection",
      label: "Instagram",
      status: "pass",
      message: `연결됨 @${inspection.username}`
    }
  ];

  const nowMs = Date.parse((deps.now ?? (() => new Date().toISOString()))());
  const health = describeTokenHealth(inspection.token, nowMs);
  checks.push({
    id: "instagram-token",
    label: "Instagram token",
    status: health.status,
    message: health.message,
    ...(health.status === "fail" ? { exitCode: CONFIG_EXIT_CODE } : {})
  });

  const tokenUsable = health.status !== "fail";
  if (inspection.token && tokenUsable) {
    const hasPermission = inspection.token.scopes.includes(PUBLISH_PERMISSION);
    checks.push({
      id: "instagram-permission",
      label: "Instagram permission",
      status: hasPermission ? "pass" : "fail",
      message: hasPermission
        ? `${PUBLISH_PERMISSION} 있음`
        : `토큰에 ${PUBLISH_PERMISSION} 권한이 없습니다. 권한을 포함해 토큰을 다시 발급하고 \`uncommitted instagram connect\`를 다시 실행하세요.`,
      ...(hasPermission ? {} : { exitCode: CONFIG_EXIT_CODE })
    });
  }

  // Hosting signs with the real clock; `now` here is only for token expiry.
  const hosting = await testImageHosting({
    homeDir: deps.homeDir,
    keychainRunner: deps.keychainRunner,
    hostingFetch: deps.hostingFetch
  });
  checks.push(
    hosting.exitCode === 0
      ? {
          id: "instagram-hosting",
          label: "Image hosting",
          status: "pass",
          message: "업로드, 공개 URL 접근, 삭제 확인"
        }
      : {
          id: "instagram-hosting",
          label: "Image hosting",
          status: "fail",
          message: hosting.stderr[0] ?? "호스팅 test에 실패했습니다.",
          exitCode: hosting.exitCode
        }
  );

  if (tokenUsable) {
    checks.push(await quotaCheck(deps, inspection.igUserId, inspection.accessToken));
  }

  return checks;
}

async function quotaCheck(
  deps: InstagramDeps,
  igUserId: string,
  accessToken: string
): Promise<DoctorCheck> {
  try {
    const { usage, total } = await readPublishingLimit(deps, igUserId, accessToken);
    return {
      id: "instagram-quota",
      label: "Instagram publishing limit",
      status: usage >= total ? "warn" : "pass",
      message:
        usage >= total
          ? `24시간 게시 한도에 도달했습니다 (${usage}/${total}). 한도가 풀릴 때까지 게시가 실패합니다.`
          : `${usage}/${total} (24시간)`
    };
  } catch {
    return {
      id: "instagram-quota",
      label: "Instagram publishing limit",
      status: "warn",
      message: "게시 한도를 확인하지 못했습니다. 네트워크를 확인하고 다시 실행하세요."
    };
  }
}
