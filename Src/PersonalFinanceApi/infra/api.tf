data "archive_file" "service" {
  type        = "zip"
  source_dir  = "${path.module}/../build"
  output_path = "${path.module}/personalfinance-api.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

# API requests end within API Gateway's 30 s; job slices use up to the 5-minute timeout and stop 60 s before it.
resource "aws_lambda_function" "api" {
  function_name    = local.function_name
  role             = aws_iam_role.api.arn
  handler          = "src/index.handler"
  runtime          = "nodejs22.x"
  timeout          = 300
  memory_size      = 1024
  filename         = data.archive_file.service.output_path
  source_code_hash = data.archive_file.service.output_base64sha256

  environment {
    variables = {
      PERSONALFINANCE_ENV                   = terraform.workspace
      PERSONALFINANCE_REGION                = var.region
      PERSONALFINANCE_BUCKET                = aws_s3_bucket.data.bucket
      PERSONALFINANCE_LEASE_TABLE           = aws_dynamodb_table.leases.name
      PERSONALFINANCE_WORKER_FUNCTION_NAME  = local.function_name
      PERSONALFINANCE_ALLOWED_EMAILS        = join(",", var.allowed_emails)
      PERSONALFINANCE_COGNITO_USER_POOL_ID  = data.aws_cognito_user_pool.shared.id
      PERSONALFINANCE_COGNITO_CLIENT_IDS    = join(",", [aws_cognito_user_pool_client.web.id, aws_cognito_user_pool_client.mcp.id])
      PERSONALFINANCE_COGNITO_DOMAIN        = local.cognito_domain
      PERSONALFINANCE_MCP_COGNITO_CLIENT_ID = aws_cognito_user_pool_client.mcp.id
      PERSONALFINANCE_MCP_SIGNING_SECRET    = var.mcp_signing_secret
      PERSONALFINANCE_API_KEYS              = var.api_keys
      PERSONALFINANCE_WEB_ORIGINS           = join(",", [local.web_origin, var.local_origin])
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# A job slice that fails is not retried by Lambda (the job records the failure); stale slices are dropped.
resource "aws_lambda_function_event_invoke_config" "api" {
  function_name                = aws_lambda_function.api.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 900
}

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins  = [local.web_origin, var.local_origin]
    allow_methods  = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers  = ["Content-Type", "Authorization", "X-Api-Key", "MCP-Protocol-Version", "MCP-Session-Id"]
    expose_headers = ["Content-Type", "MCP-Session-Id", "WWW-Authenticate"]
    max_age        = 600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each  = toset(["ANY /v1/{proxy+}", "ANY /oauth/{proxy+}", "GET /.well-known/{proxy+}"])
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# Throttled so a runaway client cannot run up the bill.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.api_host
  domain_name_configuration {
    certificate_arn = var.api_certificate_arn_regional
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = aws_apigatewayv2_api.http.id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.domain.zone_id
  name    = var.api_host
  type    = "A"
  alias {
    name                   = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
