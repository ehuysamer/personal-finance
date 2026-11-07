# Sign-in with the shared admin pool (the same as Timeseries): one app client for the web (code + PKCE in the
# browser) and one for the API's MCP sign-in (/oauth/callback). The API accepts ID tokens of both.
data "aws_cognito_user_pools" "shared" { name = var.shared_cognito_user_pool_name }
data "aws_cognito_user_pool" "shared" { user_pool_id = data.aws_cognito_user_pools.shared.ids[0] }

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.name}-web"
  user_pool_id                         = data.aws_cognito_user_pool.shared.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = ["${local.web_origin}/", "${var.local_origin}/"]
  logout_urls                          = ["${local.web_origin}/", "${var.local_origin}/"]
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  id_token_validity                    = 60
  access_token_validity                = 60
  refresh_token_validity               = 30
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_client" "mcp" {
  name                                 = "${local.name}-mcp"
  user_pool_id                         = data.aws_cognito_user_pool.shared.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  callback_urls                        = ["https://${var.api_host}/oauth/callback"]
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  id_token_validity                    = 60
  access_token_validity                = 60
  refresh_token_validity               = 1
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}
