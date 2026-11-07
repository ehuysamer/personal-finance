output "api_url" { value = "https://${var.api_host}" }
output "mcp_url" { value = "https://${var.api_host}/v1/mcp" }
output "bucket" { value = aws_s3_bucket.data.bucket }
output "cognito_domain" { value = local.cognito_domain }
output "web_client_id" { value = aws_cognito_user_pool_client.web.id }
output "web_host" { value = var.web_host }
