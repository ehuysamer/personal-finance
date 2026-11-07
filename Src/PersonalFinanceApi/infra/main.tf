# Personal finance API (doc/requirements.md): one Lambda for the REST/MCP API and the job worker (it re-invokes itself
# to continue long jobs), an HTTP API with its own domain, a private S3 bucket and a small DynamoDB lease table.
# No EC2 or ECS.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
  backend "s3" {
    bucket         = "terraform-state-2024100601"
    key            = "infra/personalfinance/api"
    region         = "ap-southeast-2"
    encrypt        = true
    dynamodb_table = "terraform-state-lock-20241006"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "personalfinance", environment = terraform.workspace }
  }
}

variable "region" { type = string }
variable "domain_name" { type = string }
variable "api_host" { type = string }
variable "web_host" { type = string }
variable "bucket" { type = string }
variable "api_certificate_arn_regional" { type = string }
# Only these sign-ins get in (the API refuses everyone else in the pool).
variable "allowed_emails" { type = list(string) }
variable "local_origin" {
  type    = string
  default = "http://127.0.0.1:5190"
}
variable "shared_cognito_user_pool_name" {
  type    = string
  default = "knowledgebase-admin-shared"
}
variable "shared_cognito_domain_prefix" {
  type    = string
  default = "knowledgebase-admin"
}
# Signs MCP tokens and OAuth codes (PERSONALFINANCE_MCP_SIGNING_SECRET in doc/secrets.local.txt).
variable "mcp_signing_secret" {
  type      = string
  sensitive = true
}
# "tenant|key" lines for scripts (PERSONALFINANCE_API_KEYS); empty means no API keys.
variable "api_keys" {
  type      = string
  sensitive = true
  default   = ""
}

locals {
  name           = "personalfinance-${terraform.workspace}"
  function_name  = "personalfinance-${terraform.workspace}-api"
  cognito_domain = "${var.shared_cognito_domain_prefix}.auth.${var.region}.amazoncognito.com"
  web_origin     = "https://${var.web_host}"
}

data "aws_route53_zone" "domain" {
  name         = var.domain_name
  private_zone = false
}
