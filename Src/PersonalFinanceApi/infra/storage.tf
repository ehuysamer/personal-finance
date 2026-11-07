# The data: {tenant}/{project} and {tenant}/{datasource} folders with $index.json lists (doc/requirements.md, Storage).
resource "aws_s3_bucket" "data" {
  bucket = var.bucket
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Old versions are kept 90 days (recovery from a bad write), then dropped to keep storage small.
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The web PUTs large statements straight to the bucket with presigned URLs.
resource "aws_s3_bucket_cors_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [local.web_origin, var.local_origin]
    allowed_headers = ["Content-Type"]
    max_age_seconds = 600
  }
}

# One running job per project.
resource "aws_dynamodb_table" "leases" {
  name         = "${local.name}-lease"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "target"
  attribute {
    name = "target"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAtEpochSeconds"
    enabled        = true
  }
}
