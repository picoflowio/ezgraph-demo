import { ApiProperty } from "@nestjs/swagger";

export class ApiRunBodyDto {
  @ApiProperty({ example: "Hi", required: false })
  message?: string;

  @ApiProperty({ example: "DemoGraph" })
  graphName!: string;

  @ApiProperty({ example: {}, required: false })
  config?: Record<string, unknown>;
}

export class ApiRunResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: false })
  completed!: boolean;

  @ApiProperty({ example: "Please enter LA and NYC." })
  message!: string;

  @ApiProperty({
    example: "Please enter LA and NYC.",
    description: "Legacy 0-charlie alias for message.",
    required: false,
  })
  bot?: string;

  @ApiProperty({ example: "af88a392-52d2-4cb4-8653-3a2da66bd28e" })
  session!: string;
}

export class ApiEndResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: "af88a392-52d2-4cb4-8653-3a2da66bd28e" })
  session!: string;

  @ApiProperty({ required: false })
  message?: string;
}
