#pragma once
#include "DatabaseEnv.h"
struct SqlOperation { virtual ~SqlOperation() = default; virtual bool Execute(SqlConnection*) = 0; };
