import { describe, expect, it } from "vitest";
import { presignS3Url, signS3Request } from "../src/s3-sigv4.js";

// Official AWS Signature Version 4 examples for Amazon S3
// (docs: "Authenticating Requests: Using Query Parameters" and
// "Examples: Signature Calculations in AWS Signature Version 4").
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
};
const NOW = new Date("2013-05-24T00:00:00Z");

describe("s3 sigv4", () => {
  it("presigns a GET URL matching the AWS query-auth example", () => {
    const url = new URL(
      presignS3Url({
        method: "GET",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
        region: "us-east-1",
        credentials: CREDENTIALS,
        now: NOW,
        expiresSeconds: 86400
      })
    );

    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("signs a header-auth request matching the AWS GET Object example", () => {
    const headers = signS3Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      credentials: CREDENTIALS,
      now: NOW,
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    });

    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });
});
