/*
 * Copyright (c) 2023, Texas Instruments Incorporated - http://www.ti.com
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * *  Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 *
 * *  Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * *  Neither the name of Texas Instruments Incorporated nor the names of
 *    its contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 * EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/*
 *  ============ ti_msp_dl_config.h =============
 *  Configured MSPM0 DriverLib module declarations
 *
 *  DO NOT EDIT - This file is generated for the MSPM0G350X
 *  by the SysConfig tool.
 */
#ifndef ti_msp_dl_config_h
#define ti_msp_dl_config_h

#define CONFIG_MSPM0G350X
#define CONFIG_MSPM0G3507

#if defined(__ti_version__) || defined(__TI_COMPILER_VERSION__)
#define SYSCONFIG_WEAK __attribute__((weak))
#elif defined(__IAR_SYSTEMS_ICC__)
#define SYSCONFIG_WEAK __weak
#elif defined(__GNUC__)
#define SYSCONFIG_WEAK __attribute__((weak))
#endif

#include <ti/devices/msp/msp.h>
#include <ti/driverlib/driverlib.h>
#include <ti/driverlib/m0p/dl_core.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 *  ======== SYSCFG_DL_init ========
 *  Perform all required MSP DL initialization
 *
 *  This function should be called once at a point before any use of
 *  MSP DL.
 */


/* clang-format off */

#define POWER_STARTUP_DELAY                                                (16)


#define GPIO_HFXT_PORT                                                     GPIOA
#define GPIO_HFXIN_PIN                                             DL_GPIO_PIN_5
#define GPIO_HFXIN_IOMUX                                         (IOMUX_PINCM10)
#define GPIO_HFXOUT_PIN                                            DL_GPIO_PIN_6
#define GPIO_HFXOUT_IOMUX                                        (IOMUX_PINCM11)
#define CPUCLK_FREQ                                                     80000000
/* Defines for SYSPLL_ERR_01 Workaround */
/* Represent 1.000 as 1000 */
#define FLOAT_TO_INT_SCALE                                               (1000U)
#define FCC_EXPECTED_RATIO                                                  2000
#define FCC_UPPER_BOUND                       (FCC_EXPECTED_RATIO * (1 + 0.003))
#define FCC_LOWER_BOUND                       (FCC_EXPECTED_RATIO * (1 - 0.003))

bool SYSCFG_DL_SYSCTL_SYSPLL_init(void);


/* Defines for UWB_CH1 */
#define UWB_CH1_INST                                                       UART1
#define UWB_CH1_INST_FREQUENCY                                          40000000
#define UWB_CH1_INST_IRQHandler                                 UART1_IRQHandler
#define UWB_CH1_INST_INT_IRQN                                     UART1_INT_IRQn
#define GPIO_UWB_CH1_RX_PORT                                               GPIOA
#define GPIO_UWB_CH1_TX_PORT                                               GPIOA
#define GPIO_UWB_CH1_RX_PIN                                        DL_GPIO_PIN_9
#define GPIO_UWB_CH1_TX_PIN                                        DL_GPIO_PIN_8
#define GPIO_UWB_CH1_IOMUX_RX                                    (IOMUX_PINCM20)
#define GPIO_UWB_CH1_IOMUX_TX                                    (IOMUX_PINCM19)
#define GPIO_UWB_CH1_IOMUX_RX_FUNC                     IOMUX_PINCM20_PF_UART1_RX
#define GPIO_UWB_CH1_IOMUX_TX_FUNC                     IOMUX_PINCM19_PF_UART1_TX
#define UWB_CH1_BAUD_RATE                                               (115200)
#define UWB_CH1_IBRD_40_MHZ_115200_BAUD                                     (21)
#define UWB_CH1_FBRD_40_MHZ_115200_BAUD                                     (45)
/* Defines for UWB_CH2 */
#define UWB_CH2_INST                                                       UART0
#define UWB_CH2_INST_FREQUENCY                                          40000000
#define UWB_CH2_INST_IRQHandler                                 UART0_IRQHandler
#define UWB_CH2_INST_INT_IRQN                                     UART0_INT_IRQn
#define GPIO_UWB_CH2_RX_PORT                                               GPIOA
#define GPIO_UWB_CH2_TX_PORT                                               GPIOA
#define GPIO_UWB_CH2_RX_PIN                                        DL_GPIO_PIN_1
#define GPIO_UWB_CH2_TX_PIN                                        DL_GPIO_PIN_0
#define GPIO_UWB_CH2_IOMUX_RX                                     (IOMUX_PINCM2)
#define GPIO_UWB_CH2_IOMUX_TX                                     (IOMUX_PINCM1)
#define GPIO_UWB_CH2_IOMUX_RX_FUNC                      IOMUX_PINCM2_PF_UART0_RX
#define GPIO_UWB_CH2_IOMUX_TX_FUNC                      IOMUX_PINCM1_PF_UART0_TX
#define UWB_CH2_BAUD_RATE                                               (115200)
#define UWB_CH2_IBRD_40_MHZ_115200_BAUD                                     (21)
#define UWB_CH2_FBRD_40_MHZ_115200_BAUD                                     (45)
/* Defines for UWB_CH3 */
#define UWB_CH3_INST                                                       UART2
#define UWB_CH3_INST_FREQUENCY                                          40000000
#define UWB_CH3_INST_IRQHandler                                 UART2_IRQHandler
#define UWB_CH3_INST_INT_IRQN                                     UART2_INT_IRQn
#define GPIO_UWB_CH3_RX_PORT                                               GPIOA
#define GPIO_UWB_CH3_TX_PORT                                               GPIOA
#define GPIO_UWB_CH3_RX_PIN                                       DL_GPIO_PIN_24
#define GPIO_UWB_CH3_TX_PIN                                       DL_GPIO_PIN_23
#define GPIO_UWB_CH3_IOMUX_RX                                    (IOMUX_PINCM54)
#define GPIO_UWB_CH3_IOMUX_TX                                    (IOMUX_PINCM53)
#define GPIO_UWB_CH3_IOMUX_RX_FUNC                     IOMUX_PINCM54_PF_UART2_RX
#define GPIO_UWB_CH3_IOMUX_TX_FUNC                     IOMUX_PINCM53_PF_UART2_TX
#define UWB_CH3_BAUD_RATE                                               (115200)
#define UWB_CH3_IBRD_40_MHZ_115200_BAUD                                     (21)
#define UWB_CH3_FBRD_40_MHZ_115200_BAUD                                     (45)
/* Defines for UWB_CH4 */
#define UWB_CH4_INST                                                       UART3
#define UWB_CH4_INST_FREQUENCY                                          80000000
#define UWB_CH4_INST_IRQHandler                                 UART3_IRQHandler
#define UWB_CH4_INST_INT_IRQN                                     UART3_INT_IRQn
#define GPIO_UWB_CH4_RX_PORT                                               GPIOA
#define GPIO_UWB_CH4_TX_PORT                                               GPIOA
#define GPIO_UWB_CH4_RX_PIN                                       DL_GPIO_PIN_25
#define GPIO_UWB_CH4_TX_PIN                                       DL_GPIO_PIN_26
#define GPIO_UWB_CH4_IOMUX_RX                                    (IOMUX_PINCM55)
#define GPIO_UWB_CH4_IOMUX_TX                                    (IOMUX_PINCM59)
#define GPIO_UWB_CH4_IOMUX_RX_FUNC                     IOMUX_PINCM55_PF_UART3_RX
#define GPIO_UWB_CH4_IOMUX_TX_FUNC                     IOMUX_PINCM59_PF_UART3_TX
#define UWB_CH4_BAUD_RATE                                               (115200)
#define UWB_CH4_IBRD_80_MHZ_115200_BAUD                                     (43)
#define UWB_CH4_FBRD_80_MHZ_115200_BAUD                                     (26)




/* Defines for LCD_SPI */
#define LCD_SPI_INST                                                       SPI1
#define LCD_SPI_INST_IRQHandler                                 SPI1_IRQHandler
#define LCD_SPI_INST_INT_IRQN                                     SPI1_INT_IRQn
#define GPIO_LCD_SPI_PICO_PORT                                            GPIOB
#define GPIO_LCD_SPI_PICO_PIN                                     DL_GPIO_PIN_8
#define GPIO_LCD_SPI_IOMUX_PICO                                 (IOMUX_PINCM25)
#define GPIO_LCD_SPI_IOMUX_PICO_FUNC                 IOMUX_PINCM25_PF_SPI1_PICO
/* GPIO configuration for LCD_SPI */
#define GPIO_LCD_SPI_SCLK_PORT                                            GPIOB
#define GPIO_LCD_SPI_SCLK_PIN                                     DL_GPIO_PIN_9
#define GPIO_LCD_SPI_IOMUX_SCLK                                 (IOMUX_PINCM26)
#define GPIO_LCD_SPI_IOMUX_SCLK_FUNC                 IOMUX_PINCM26_PF_SPI1_SCLK



/* Port definition for Pin Group LCD_CONTROL */
#define LCD_CONTROL_PORT                                                 (GPIOB)

/* Defines for LCD_CS: GPIOB.6 with pinCMx 23 on package pin 58 */
#define LCD_CONTROL_LCD_CS_PIN                                   (DL_GPIO_PIN_6)
#define LCD_CONTROL_LCD_CS_IOMUX                                 (IOMUX_PINCM23)
/* Defines for LCD_DC: GPIOB.24 with pinCMx 52 on package pin 23 */
#define LCD_CONTROL_LCD_DC_PIN                                  (DL_GPIO_PIN_24)
#define LCD_CONTROL_LCD_DC_IOMUX                                 (IOMUX_PINCM52)
/* Defines for LCD_RESET: GPIOB.20 with pinCMx 48 on package pin 19 */
#define LCD_CONTROL_LCD_RESET_PIN                               (DL_GPIO_PIN_20)
#define LCD_CONTROL_LCD_RESET_IOMUX                              (IOMUX_PINCM48)
/* Port definition for Pin Group SET_ID_INPUTS */
#define SET_ID_INPUTS_PORT                                               (GPIOA)

/* Defines for SET_ID_BIT0: GPIOA.28 with pinCMx 3 on package pin 35 */
#define SET_ID_INPUTS_SET_ID_BIT0_PIN                           (DL_GPIO_PIN_28)
#define SET_ID_INPUTS_SET_ID_BIT0_IOMUX                           (IOMUX_PINCM3)
/* Defines for SET_ID_BIT1: GPIOA.31 with pinCMx 6 on package pin 39 */
#define SET_ID_INPUTS_SET_ID_BIT1_PIN                           (DL_GPIO_PIN_31)
#define SET_ID_INPUTS_SET_ID_BIT1_IOMUX                           (IOMUX_PINCM6)
/* Defines for SET_ID_BIT2: GPIOA.13 with pinCMx 35 on package pin 6 */
#define SET_ID_INPUTS_SET_ID_BIT2_PIN                           (DL_GPIO_PIN_13)
#define SET_ID_INPUTS_SET_ID_BIT2_IOMUX                          (IOMUX_PINCM35)
/* Defines for SET_ID_BIT3: GPIOA.16 with pinCMx 38 on package pin 9 */
#define SET_ID_INPUTS_SET_ID_BIT3_PIN                           (DL_GPIO_PIN_16)
#define SET_ID_INPUTS_SET_ID_BIT3_IOMUX                          (IOMUX_PINCM38)
/* Port definition for Pin Group DIP_LEGACY_PROBE */
#define DIP_LEGACY_PROBE_PORT                                            (GPIOB)

/* Defines for PB0: GPIOB.0 with pinCMx 12 on package pin 47 */
#define DIP_LEGACY_PROBE_PB0_PIN                                 (DL_GPIO_PIN_0)
#define DIP_LEGACY_PROBE_PB0_IOMUX                               (IOMUX_PINCM12)
/* Defines for PB1: GPIOB.1 with pinCMx 13 on package pin 48 */
#define DIP_LEGACY_PROBE_PB1_PIN                                 (DL_GPIO_PIN_1)
#define DIP_LEGACY_PROBE_PB1_IOMUX                               (IOMUX_PINCM13)
/* Defines for PB2: GPIOB.2 with pinCMx 15 on package pin 50 */
#define DIP_LEGACY_PROBE_PB2_PIN                                 (DL_GPIO_PIN_2)
#define DIP_LEGACY_PROBE_PB2_IOMUX                               (IOMUX_PINCM15)
/* Defines for PB3: GPIOB.3 with pinCMx 16 on package pin 51 */
#define DIP_LEGACY_PROBE_PB3_PIN                                 (DL_GPIO_PIN_3)
#define DIP_LEGACY_PROBE_PB3_IOMUX                               (IOMUX_PINCM16)
/* Port definition for Pin Group LOCK_OUTPUTS */
#define LOCK_OUTPUTS_PORT                                                (GPIOA)

/* Defines for RED_LED: GPIOA.14 with pinCMx 36 on package pin 7 */
#define LOCK_OUTPUTS_RED_LED_PIN                                (DL_GPIO_PIN_14)
#define LOCK_OUTPUTS_RED_LED_IOMUX                               (IOMUX_PINCM36)
/* Defines for GREEN_LED: GPIOA.15 with pinCMx 37 on package pin 8 */
#define LOCK_OUTPUTS_GREEN_LED_PIN                              (DL_GPIO_PIN_15)
#define LOCK_OUTPUTS_GREEN_LED_IOMUX                             (IOMUX_PINCM37)
/* Defines for BUZZER: GPIOA.12 with pinCMx 34 on package pin 5 */
#define LOCK_OUTPUTS_BUZZER_PIN                                 (DL_GPIO_PIN_12)
#define LOCK_OUTPUTS_BUZZER_IOMUX                                (IOMUX_PINCM34)
/* Defines for WELCOME_LED: GPIOA.7 with pinCMx 14 on package pin 49 */
#define LOCK_OUTPUTS_WELCOME_LED_PIN                             (DL_GPIO_PIN_7)
#define LOCK_OUTPUTS_WELCOME_LED_IOMUX                           (IOMUX_PINCM14)
/* Port definition for Pin Group LOCK_RELAY */
#define LOCK_RELAY_PORT                                                  (GPIOB)

/* Defines for DRIVE: GPIOB.19 with pinCMx 45 on package pin 16 */
#define LOCK_RELAY_DRIVE_PIN                                    (DL_GPIO_PIN_19)
#define LOCK_RELAY_DRIVE_IOMUX                                   (IOMUX_PINCM45)


/* clang-format on */

void SYSCFG_DL_init(void);
void SYSCFG_DL_initPower(void);
void SYSCFG_DL_GPIO_init(void);
void SYSCFG_DL_SYSCTL_init(void);

bool SYSCFG_DL_SYSCTL_SYSPLL_init(void);
void SYSCFG_DL_UWB_CH1_init(void);
void SYSCFG_DL_UWB_CH2_init(void);
void SYSCFG_DL_UWB_CH3_init(void);
void SYSCFG_DL_UWB_CH4_init(void);
void SYSCFG_DL_LCD_SPI_init(void);


bool SYSCFG_DL_saveConfiguration(void);
bool SYSCFG_DL_restoreConfiguration(void);

#ifdef __cplusplus
}
#endif

#endif /* ti_msp_dl_config_h */
