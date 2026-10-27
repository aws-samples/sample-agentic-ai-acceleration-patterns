# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Call native Memory HTTP operations through a named Gateway target.

The SDK service model supplies the path and wire format. This client performs
no local authorization: Gateway must authenticate the JWT and enforce Cedar.
"""
import re
from urllib.parse import urlsplit

import httpx
from botocore.serialize import create_serializer
from botocore.session import Session
from botocore.validate import validate_parameters


class GatewayDenied(RuntimeError):
    """A 403 denial; other HTTP errors must not count as isolation evidence."""


class GatewayMemory:
    """Forward a caller token per request; never follow redirects with it."""

    def __init__(self, gateway_url, target_name, token, *, transport=None):
        parsed = urlsplit(gateway_url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or
                parsed.password or parsed.query or parsed.fragment or
                parsed.path not in ("", "/", "/mcp", "/mcp/")):
            raise ValueError("Use the HTTPS Gateway URL returned by GetGateway, without extra routing.")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", target_name):
            raise ValueError("Invalid target name")
        if not token or any(character.isspace() for character in token):
            raise ValueError("Supply one bearer token without whitespace")
        self.base = f"https://{parsed.netloc}/{target_name}"
        self.token = token
        self.model = Session().get_service_model("bedrock-agentcore")
        self.serializer = create_serializer(self.model.protocol)
        self.http = httpx.Client(transport=transport, follow_redirects=False, timeout=30)

    def call(self, operation, parameters):
        """Serialize one Memory operation and return its JSON response.

        Example: client.call("RetrieveMemoryRecords", {
            "memoryId": memory_id, "namespacePath": shared_namespace,
            "searchCriteria": {"searchQuery": "warehouse codename", "topK": 10},
        })
        """
        operation_model = self.model.operation_model(operation)
        validate_parameters(parameters, operation_model.input_shape)
        wire = self.serializer.serialize_to_request(parameters, operation_model)
        response = self.http.request(
            wire["method"], self.base + wire["url_path"],
            params=wire.get("query_string"),
            headers={**wire["headers"], "Authorization": f"Bearer {self.token}"},
            content=wire["body"],
        )
        if response.status_code == 403:
            denial = GatewayDenied(f"{operation}: access denied")
            # Keep bounded service diagnostics separate from the public message.
            # Only the ignored local deployment diagnostic file records them.
            body = response.text.replace(self.token, "[REDACTED]")
            body = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                          "[REDACTED]", body)
            denial.diagnostic = {
                "operation": operation, "statusCode": 403,
                "requestId": response.headers.get("x-amzn-requestid"),
                "body": body[:4000],
            }
            raise denial
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            body = response.text.replace(self.token, "[REDACTED]")
            body = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                          "[REDACTED]", body)
            error.diagnostic = {
                "operation": operation, "statusCode": response.status_code,
                "requestId": response.headers.get("x-amzn-requestid"),
                "body": body[:4000],
            }
            raise
        return response.json() if response.content else {}

    def close(self):
        """Release the HTTP connection pool."""
        self.http.close()
