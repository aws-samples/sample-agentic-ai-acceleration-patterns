// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The token-exchange Lambda entry (R-7). A dumb pass-through, like every
 * other handler in the sample: convert the API Gateway v1 event to an
 * HttpRequest, dispatch to the generated service handler, convert the
 * response back. The body may arrive base64-encoded because the OpenAPI
 * marks `application/x-www-form-urlencoded` a binary media type;
 * `convertEvent` decodes `isBase64Encoded` for us.
 *
 * The token SSDK was generated with `disableDefaultValidation`, so the
 * handler factory requires a `ValidationCustomizer`. The only modelled
 * constraint is that `form` is required, which the deserializer always
 * satisfies, and the real validation lives in `parseExchangeForm`. So the
 * customizer maps any (unexpected) validation failure to an OAuthError
 * `invalid_request` rather than letting the framework emit its own shape.
 */

import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { ValidationContext, ValidationFailure } from '@smithy/server-common';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { OAUTH_ERROR_DESCRIPTIONS } from './form';
import { TokenExchangeService } from './token-exchange';
import { getTokenServiceServiceHandler, OAuthError } from '../smithy/token/typescript-ssdk-codegen/src';

/**
 * Turn any modelled validation failure into an RFC 6749 `invalid_request`,
 * so the wire error keeps the `{error, error_description}` shape. Returning
 * `undefined` would mean "no error"; we never do, because a failure here is
 * a genuine malformed request.
 */
export function validationCustomizer(
  _context: ValidationContext<'ExchangeToken'>,
  _failures: ValidationFailure[],
): OAuthError {
  const description = OAUTH_ERROR_DESCRIPTIONS.invalid_request;
  return new OAuthError({ message: description, code: 'invalid_request', description });
}

const service = new TokenExchangeService<Record<string, unknown>>({
  cognito: new CognitoIdentityProviderClient({}),
});

const serviceHandler = getTokenServiceServiceHandler(service, validationCustomizer);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const httpResponse = await serviceHandler.handle(convertEvent(event), {});
  return convertVersion1Response(httpResponse);
}
